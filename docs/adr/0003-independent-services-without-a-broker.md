---
status: accepted
---

# Build independent services that communicate without a broker

We split the backend into independent services: Telemetry, Evaluation, Prompt, Identity and the
Gateway. Each owns its data and has its own logical database, and services never read each other's
tables. We preferred this over a modular monolith because it gives database isolation, independent
releases, smaller per-service images and room for several teams.

In v1, services communicate only through synchronous HTTP calls to each other's contracts, with no
event broker. A broker would be one more component that every on-premises customer must run. The one
flow that looked event-driven, detecting that a trace is complete, works by polling instead. The
Evaluation worker polls Telemetry's public trace API every 2 seconds, only while Iterations are
running, and customer scripts use the same API.

## Considered Options

- **Modular monolith with roles (rejected):** It would be simpler to operate, to change across
  modules and to run as one local process. It was rejected for weaker isolation and shared releases.
  See the comparison in the design discussion.
- **Services with an event broker (rejected for v1):** It would deliver changes faster and decouple
  services more. It was rejected because no v1 flow needs it badly enough to justify running the
  broker.

## Consequences

- The single-image local deployment runs all services in one process, each with its own SQLite file.
  Service clients call the same request handlers directly instead of over the network, so CI must
  test both deployments.
- Operations that span services need explicit orchestration. For example, when a Project is deleted,
  Identity marks it deleted and the other services poll for deleted Projects and purge their data.
- Data in different services can briefly disagree. Evaluation keeps copies of everything it needs to
  display results, so a finished run stays readable after telemetry retention expires.
- Revisit the broker decision when a flow needs low-latency propagation or polling load becomes
  measurable.
