---
status: accepted
---

# Daily log partitions on the record's own time, with a window that refuses the rest

On PostgreSQL, `logs` is range-partitioned by day on `time_unix_nano`, the time the record says it
happened. Ingestion creates a day's partition when the day's first record arrives. A record whose
time is more than 30 days old or more than one day ahead of the platform's clock is rejected through
`partial_success`. SQLite keeps one ordinary table.

```sql
create table if not exists "logs_20261109" partition of "logs"
  for values from ('01794182400000000000') to ('01794268800000000000');
```

Partitioning lets retention (roadmap step 13) drop a table instead of deleting billions of rows, and
a time range reads only the partitions it overlaps. The partition key must be the time that queries
filter on, or nothing can be skipped. That time comes from the client, so without a limit a wrong
clock could create a partition per bad timestamp. The window bounds them to 32 days. Loki rejects
samples outside a similar window (`reject_old_samples_max_age`, `creation_grace_period`), and a
record older than the retention period would be deleted at once anyway.

The key is the same 20-digit text as on spans, because SQLite drivers return 64-bit integers as
lossy JavaScript numbers. Text of equal length with only digits sorts like the number, so range
partitions and pruning work, and both databases run the same comparisons. It costs 12 bytes more per
index entry than `bigint`.

No scheduler exists before step 13, so ingestion creates partitions. `create table if not exists`
alone is not safe when replicas race: a test showed `relation already exists` on the losers. Each
creation therefore takes an advisory lock in its own transaction, and each replica remembers which
days exist.

## Considered Options

- **Partition by receive time.** The platform's clock needs no window, but a query on the record's
  time could skip no partition, and bounding the receive time by the query's range would silently
  miss late batches.
- **`bigint` key on PostgreSQL only.** Smaller, but the storage and query code would differ by
  database for every time comparison.
- **Clamp bad timestamps to the receive time instead of rejecting.** Keeps the record but shows it
  at a time that never happened. Rejection is visible in the UI's rejected count.
- **No partitions, batched deletes.** Simpler, but at 5,000 records per second the deletes compete
  with ingestion and leave bloat for vacuum.

## Consequences

- `create table ... partition of` briefly takes an exclusive lock on `logs`, once a day per day of
  data. A five-second lock timeout keeps a long-running query from queueing everyone behind it; the
  batch then gets a retryable `503`.
- A per-Project retention shorter than the partition's day still needs row deletes, and one longer
  than 30 days needs a wider window.
