---
status: accepted
---

# Metric Time Series are stored once, and cumulative values are resolved at query time

A Metric's Time Series is stored once in `metric_series`, and each point in `metric_points` holds
only the series' ID, its times and its numbers. Cumulative sums and histograms are stored as the
exporter sent them. A query turns them into increases with `lag()` over each series' points, on both
databases, and treats a falling value or a new start time as a reset. Histogram bucket counts are
JSON text, and `p95` is computed from them in TypeScript.

```sql
select series_id,
  case
    when previous_value is null then case when start_time_unix_nano >= :lookback then value end
    when value < previous_value or start_time_unix_nano <> previous_start_time then value
    else value - previous_value
  end as increase
from (
  select series_id, time_unix_nano, start_time_unix_nano, value,
    lag(value) over series_points as previous_value,
    lag(start_time_unix_nano) over series_points as previous_start_time
  from metric_points
  where ...
  window series_points as (partition by series_id order by time_unix_nano)
) as points_with_previous
```

An application exports every Time Series again and again with the same attributes, often both its
resource attributes and its own, so storing them on each point would multiply the table's size for
nothing. Prometheus and Mimir keep the same split between an index of series and their samples.
Filters and grouping then work on the much smaller series table, in TypeScript, so both databases
read attributes the same way.

Resolving cumulative values when they are read keeps ingestion stateless: replicas behind a load
balancer receive a series' points in any order, and converting to deltas on arrival would need the
previous point of every series shared between them. The OpenTelemetry Collector's
`cumulativetodelta` processor needs exactly that state, which is why it runs in one process. A query
already reads the points in order, so `lag()` costs little there.

## Considered Options

- **Attributes on every point.** One table and simpler writes, but a multiple of the storage and the
  same JSON filtered over and over. Listing a Metric's attributes would scan its points.
- **Deltas at ingestion.** Simpler queries, but state per Time Series that every replica must share,
  lost on a restart, and wrong when a batch arrives out of order.
- **Histograms in columns per bucket or a second table.** Queryable in SQL, but bounds differ by
  Metric. Nothing needs a bucket in SQL, because the quantile is computed in TypeScript.
- **Quantiles in SQL.** Possible on PostgreSQL with arrays, but SQLite has no such functions, and
  the two would round differently.

## Consequences

- A query without the point before its first one in the lookback window, ten minutes or one step,
  cannot tell how much of a cumulative value falls into its range, and leaves it out unless the
  series started inside that window.
- A query reads at most 100,000 rows, and a histogram query holds them with their bucket counts, so
  a long range at a fine step must be narrowed.
- `metric_series` grows with every new combination of attributes and is never pruned until retention
  (roadmap step 13) removes series that have not been seen for its period.
- Different histogram bounds start a new Time Series, so the bounds of a series' points always match
  and increases can be taken bucket by bucket.
