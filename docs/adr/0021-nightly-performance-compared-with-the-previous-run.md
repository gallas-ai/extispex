---
status: accepted
---

# Nightly performance is compared with the previous run's commit, measured again on the same runner

The nightly workflow [nightly-performance.yml](../../.github/workflows/nightly-performance.yml)
measures the separate services on PostgreSQL on a standard GitHub runner. It fails when a throughput
is more than 25% lower or a p95 latency more than 25% higher than for the previous successful run's
commit. Each run's results are a JSON file kept as the workflow artifact `performance-results` for
90 days. The next run finds the newest one through the artifacts API, reads the commit it measured,
checks that commit out next to the current one and measures both, one after the other, on the same
runner. A run without a previous artifact only records.

```text
run N-1 ──upload──▶ artifact performance-results {commit: A, measurements}
run N   ──gh api: newest performance-results of the branch──▶ commit A
        ├─ measure commit A (git worktree, its own services and dependencies)
        ├─ measure commit B, the current one (with the injected delay, if any)
        └─ compare B with A ──▶ pass/fail; upload B's results only when it passed without a delay
```

| Measured (`tests/performance/`)                           | Kind                        |
| --------------------------------------------------------- | --------------------------- |
| Spans, log records and metric data points through OTLP    | throughput, best of 3       |
| Six UI queries through the Gateway: traces, logs, metrics | p95, lowest of 3 passes     |
| Evaluation jobs through pg-boss, and a run until verdict  | throughput and p95, one run |

The repository is public, so a standard runner costs nothing, while a dedicated machine never is
(see [architecture.md](../architecture.md#11-quality)). Standard runners differ in speed: before
merging, two runs of the same commit on GitHub differed by 30 to 80% in every measurement, one
taking 6 minutes and the other 11. Comparing with the stored numbers of the previous run would fail
on a slow runner and pass a real regression on a fast one. Measuring both commits on one runner
removes the difference between machines and keeps the previous run as the reference, as the owner
decided. The best of several rounds removes most of a runner's short hiccups, which only ever make a
round slower. 25% was chosen, not measured over many nights.

The workflow input `injected_delay_milliseconds` adds a delay before every request of the current
commit's measurement, on the client's side. It shows that the comparison fails, without a test-only
switch in any service. Such a run never serves as a baseline.

## Considered Options

- **Previous run's commit, measured again (chosen):** No write access to the repository, nothing to
  host, and no difference between machines. A run takes twice as long, about 20 minutes, which a
  free runner allows.
- **The previous run's stored numbers:** Half the time, but the runner's speed decides the result.
  Rejected after the measurements above.
- **A baseline file committed to `main`, or a history on a `gh-pages` branch as
  `github-action-benchmark` keeps it:** Reviewable history and charts, but a bot would push to a
  protected branch, and the numbers still come from different machines.
- **The median of the last several runs:** Less sensitive to one noisy night, but still compares
  machines, and needs several artifacts.
- **Absolute limits, such as the capacity target of 5,000 spans per second:** Meaningful only on a
  known machine; that is the deferred capacity check, not a regression test.

## Consequences

- A regression that grows by less than 25% per night passes every single comparison. The artifacts
  of several runs show a trend.
- The current measurement script runs against the previous commit's services through
  `E2E_SOURCE_DIRECTORY` of `tests/e2e/deployment.ts`. A change that the old services cannot run,
  such as a new required environment variable, leaves that run without a measurement of the previous
  commit; it then only records, and the next run compares again.
- After 90 days without a successful run, the artifact has expired and the next run only records.
  GitHub also turns off scheduled workflows in a public repository after 60 days without activity.
- A failed run keeps its results as `performance-results-not-compared` for inspection; the next run
  still compares with the last good commit, so a regression keeps failing until it is fixed.
- OTLP ingestion goes to Telemetry's OTLP/HTTP endpoint, as an application sends it; the Gateway
  forwards only the public REST API.
