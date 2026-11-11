---
status: accepted
---

# Each service removes data in a leased periodic run, and shared days drop only past every Project

Retention and Project deletion remove data in every service, but only Evaluation has a job queue
(ADR 0001) and there is no broker (ADR 0003). Each service therefore runs one periodic **data
lifecycle**, every ten minutes by default (`DATA_LIFECYCLE_INTERVAL_MILLISECONDS`). A row in the
service's own database, a lease taken by compare-and-set, lets one replica at a time do the work.
The same statement runs on PostgreSQL and SQLite:

```sql
insert into background_leases (name, holder, expires_at_epoch_milliseconds) values (?, ?, ?)
  on conflict (name) do update set holder = excluded.holder,
    expires_at_epoch_milliseconds = excluded.expires_at_epoch_milliseconds
  where background_leases.expires_at_epoch_milliseconds <= ?   -- expired
     or background_leases.holder = excluded.holder;           -- or already mine
select holder from background_leases where name = ?;           -- did I get it?
```

The lease lasts two intervals and its holder renews it on every run, so another replica takes over
when the holder stops. Each run asks Identity's internal `GET /internal/v1/project-lifecycle` with a
service token for every Project's Retention Period and for the deleted Projects that this service
still has to remove, removes them, and reports each with
`PUT /internal/v1/deleted-projects/{projectId}/data-removal`. Identity removes its own data the same
way, without HTTP. `create-service.ts` exposes the run as `runDataLifecycle()`, so tests drive it
with their own clock, and `main.ts` schedules it.

**A removal is final only after every access token for the Project expired.** Services verify access
tokens themselves for up to five minutes, so a token issued before the deletion can still write
after a service removed the data. Identity keeps listing a deleted Project to a service until that
service reports a removal at least the token lifetime after the deletion; the UI shows "Removing"
until then and "Removed" after.

**Telemetry's daily partitions are shared by all Projects**, while the Retention Period is per
Project. On PostgreSQL a day of `logs_<yyyymmdd>` and `metric_points_<yyyymmdd>` is dropped when it
ended before both the longest Retention Period of any Project and the 30-day window in which
ingestion still accepts records (ADR 0012), so no replica ever needs a dropped partition again.
Projects with a shorter period lose their older Log Records and metric points row by row. A Project
whose period is the one that decides the drop has no row deletes: its records go with their day, up
to one day after the period. SQLite deletes rows for every Project. Spans have no partitions and are
deleted by their start time, Time Series when they were last seen before the period, and rejected
counts after the 24 hours they are shown for.

## Considered Options

- **The job queue in every service.** pg-boss can schedule singletons, but Telemetry, Prompt and
  Identity would each need pg-boss and a SQLite queue just for one periodic task.
- **Evaluation's own job queue for its part.** It has one, but its jobs are attempts with retries
  and a delivery limit; a periodic removal would need a new job kind in pg-boss and in the SQLite
  queue and a scheduler anyway. The worker uses the same lease as the other services.
- **Every replica runs the work.** Removals are idempotent, but every replica would ask Identity and
  scan the same rows each interval, and partition drops would queue behind each other.
- **Partitions per Project.** Retention would always drop tables, but the number of tables grows
  with Projects times days, and a time range would read a partition per Project.
- **Row deletes for every Project on PostgreSQL.** Exact to the minute, but deleting a day's rows of
  a busy Project every ten minutes is the competition with ingestion that partitions avoid.

## Consequences

- On PostgreSQL, telemetry of the Projects with the longest Retention Period stays readable up to a
  day longer than the period. The UI says "no longer available" by the period itself.
- A Retention Period longer than 30 days keeps records longer, but ingestion still refuses records
  older than 30 days.
- A service that is down simply removes the data on its next run; nothing is lost, but the UI shows
  the service as waiting until then.
- Removing a large Project, or the expired rows of a busy one, is one statement per table and has
  not been measured at the capacity target.
- A deactivated user's email, name, password and sign-in identities are deleted for good 30 days
  after deactivation in Identity's run. The row stays with its ID, shown as "Deleted user", so that
  what refers to it, such as a directory import, still resolves; it cannot be reactivated.
