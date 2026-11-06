---
status: accepted
---

# Use pg-boss for the Evaluation job queue

The business specification tentatively proposed BullMQ for long-running jobs. We chose pg-boss on
top of the Evaluation service's PostgreSQL database, because BullMQ would add Redis as a new piece
of infrastructure that every on-premises customer has to run, back up and upgrade, and it would give
us no benefit that matters for this workload.

Evaluation throughput is limited by calls to LLM providers and to the user's application, not by the
queue. An Evaluation Run produces far fewer jobs than the broker-grade throughput BullMQ offers, so
its speed advantage does not change how long a run takes.

## Considered Options

- **pg-boss on PostgreSQL (chosen):** No new infrastructure. Jobs live in the service's own
  database, so they share its backups and operations.
- **BullMQ on Redis:** Likely faster and more feature-rich, including parent and child job flows.
  Rejected because it adds Redis to every production deployment.

Neither option runs in the single-image local deployment, which uses SQLite only, so that deployment
needs its own small SQLite-backed queue in either case.

## Evidence

We ran both libraries on Deno 2.9.5 on macOS against local servers on 2026-11-04. Both completed
every job in a small test, including a retry after a failed job.

|                | pg-boss 12.38.0                                 | BullMQ 6.5.4 (Redis 8.10.2)                   |
| -------------- | ----------------------------------------------- | --------------------------------------------- |
| Jobs completed | 201 of 201, with a retry                        | 200 of 200; separately 51 of 51, with a retry |
| Time           | 7.2 s, with 0.5 s polling and a 1 s retry delay | 0.15 s for the 200-job run                    |

These timings are not a benchmark, because the two runs used different settings. The first BullMQ
run also stalled for an unknown reason and did not recur in two later runs. This did not decide the
choice, but anyone revisiting BullMQ should run a longer soak test first.

We have not yet tested pg-boss under sustained load, in a container or against a managed PostgreSQL
service. The first implementation should verify all three.

## Consequences

- The queue is private to the Evaluation service. No other service reads from it or writes to it.
- Evaluation code depends on a queue interface, so that pg-boss, the SQLite queue and any future
  replacement stay interchangeable.
- Revisit this decision if measured queue load, rather than LLM and application latency, starts to
  limit Evaluation Runs, or if queue load starts to affect the Evaluation database.
