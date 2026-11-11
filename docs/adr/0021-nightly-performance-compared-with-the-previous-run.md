---
status: accepted
---

# Nightly performance is compared with the previous run, kept as a workflow artifact

The nightly workflow [nightly-performance.yml](../../.github/workflows/nightly-performance.yml)
measures the separate services on PostgreSQL on a standard GitHub runner and compares each
measurement with the previous successful run on `main`. The run fails when a throughput is more than
25% lower or a p95 latency more than 25% higher. Each run's results are a JSON file kept as the
workflow artifact `performance-results` for 90 days; the next run finds the newest one through the
artifacts API and downloads it. A run without a previous artifact only records.

```text
nightly run N-1 ──upload──▶ artifact performance-results (run N-1)
nightly run N   ──gh api: newest performance-results on main──▶ download ──▶ compare ──▶ pass/fail
                └─upload only when it passed and had no injected delay
```

| Measured (`tests/performance/`)                           | Kind       |
| --------------------------------------------------------- | ---------- |
| Spans, log records and metric data points through OTLP    | throughput |
| Six UI queries through the Gateway: traces, logs, metrics | p95        |
| Evaluation jobs through pg-boss, and a run until verdict  | both       |

The repository is public, so a standard runner costs nothing, while a dedicated machine never is
(see [architecture.md](../architecture.md#11-quality)). A standard runner's speed varies from run to
run, so absolute limits would fail on a slow machine and pass a real regression on a fast one. The
previous run is the nearest comparable measurement: same workflow, same amount of data and, most
nights, one day of changes. 25% was chosen, not measured: it should be wider than the variation
between two runners and still catch a missing index or a query that reads every partition. The first
weeks of runs show whether it is.

The workflow input `injected_delay_milliseconds` adds a delay before every request on the client's
side. It shows that the comparison fails, without a test-only switch in any service. Such a run
never serves as a baseline.

## Considered Options

- **Previous run's artifact (chosen):** No write access to the repository and nothing to host.
  Artifacts expire, and slow decline below 25% per night is not caught.
- **A baseline file committed to `main`:** Reviewable history, but a bot would push to `main`, which
  the `Protect main` ruleset reserves for the owner, or open a pull request every night.
- **A benchmark history on a `gh-pages` branch, as `github-action-benchmark` keeps it:** Charts and
  a long history, but the workflow needs `contents: write` and another branch to protect.
- **The median of the last several runs:** Less sensitive to one noisy night, but needs several
  artifacts per run and gives a first verdict only after a week. Worth revisiting if single noisy
  runs fail too often.
- **Absolute limits, such as the capacity target of 5,000 spans per second:** Meaningful only on a
  known machine; that is the deferred capacity check, not a regression test.

## Consequences

- A regression that grows by less than 25% per night passes every single comparison. Anyone looking
  at a trend needs the artifacts of several runs.
- After 90 days without a successful run on `main`, the artifact has expired and the next run only
  records. GitHub also turns off scheduled workflows in a public repository after 60 days without
  activity.
- A failed run keeps its results as `performance-results-not-compared` for inspection; the next run
  still compares with the last good one, so a regression keeps failing until it is fixed.
- Only runs of the same amount of work are comparable: changing the workload in
  `tests/performance/measure-performance.ts` or a measurement's meaning needs a new measurement
  `id`, which the next run then only records.
- OTLP ingestion goes to Telemetry's OTLP/HTTP endpoint, as an application sends it; the Gateway
  forwards only the public REST API.
