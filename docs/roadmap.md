# Roadmap

The order in which the design in [architecture.md](architecture.md) gets built. Each step is one
working session that ends with a merged pull request and green CI. Terms are defined in
[GLOSSARY.md](../GLOSSARY.md).

## Status

| Step | Session                                                                                                | Status |
| ---- | ------------------------------------------------------------------------------------------------------ | ------ |
| 0    | First trace pipeline and CI on GitHub                                                                  | Done   |
| 1    | [Prompt service](#1-prompt-service)                                                                    | Done   |
| 2    | [Projects and API keys](#2-projects-and-api-keys)                                                      | Done   |
| 3    | [Users, Groups, Roles and tokens](#3-users-groups-roles-and-tokens)                                    | Done   |
| 4    | [Datasets and Client-Driven Execution](#4-datasets-and-client-driven-execution)                        | Next   |
| 5    | [Trace completion and Telemetry Evaluator](#5-trace-completion-and-telemetry-evaluator)                |        |
| 6    | [Server-Driven Execution and Session Test Cases](#6-server-driven-execution-and-session-test-cases)    |        |
| 7    | [LLM providers, Grading Evaluator and LLM Summary](#7-llm-providers-grading-evaluator-and-llm-summary) |        |
| 8    | [Reports](#8-reports)                                                                                  |        |
| 9    | [OIDC sign-in](#9-oidc-sign-in)                                                                        |        |
| 10   | [SCIM and file import](#10-scim-and-file-import)                                                       |        |
| 11   | [Logs](#11-logs)                                                                                       |        |
| 12   | [Metrics](#12-metrics)                                                                                 |        |
| 13   | [Retention and Project deletion](#13-retention-and-project-deletion)                                   |        |
| 14   | [Helm chart](#14-helm-chart)                                                                           |        |
| 15   | [Nightly performance test and module boundaries](#15-nightly-performance-test-and-module-boundaries)   |        |

Update this table at the end of each session.

## Why this order

- **Prompt first.** It is the smallest service, and the Grading Evaluator and LLM Summary reference
  Prompt Versions. As the second service, it also sets the patterns every later service copies: a
  second database in CI, Gateway routing to several services and the combined OpenAPI document.
- **Identity core before Evaluation.** The Evaluation worker needs a service token to read Telemetry
  and Prompt data for a Project. Building a temporary mechanism for that and replacing it later
  costs more than building Projects, API keys and tokens first. Company sign-in (OIDC, SCIM) is not
  needed for that, so it waits until steps 9 and 10, before the first customer deployment.
- **Evaluation in five slices.** Each slice delivers something usable and stays small enough for one
  session. Client-Driven Execution with the Regex Evaluator comes first because it needs neither LLM
  providers nor calls to a Target.
- **Logs and metrics after Evaluation.** Evaluation does not need them, and the trace pipeline
  already shows the ingestion pattern to follow.
- **Retention together with Project deletion.** Both remove data in the background in every service,
  so they share one mechanism.

## Rules for every session

A session is done when:

- It works in both deployments: separate services on PostgreSQL and `all-in-one` on SQLite.
- Every storage change has a migration for both databases and tests that run on both.
- A new service has `create-service.ts`, `main.ts`, a Dockerfile, an entry in
  `deploy/compose/compose.yaml`, its own PostgreSQL database in CI and an image build in the
  `container-images` CI job, and is listed in the README's image table.
- UI for the feature is part of the same session, not a later one.
- e2e tests cover the new flow through the Gateway.
- `docs/architecture.md` says what was verified and what was not, and `GLOSSARY.md` has any new
  term. A hard-to-reverse decision gets an ADR.
- The Status table above is updated.

Each step lists **decisions to make first**. These are open questions the architecture does not
answer. Settle them with the user at the start of the session, before writing code.

## Starting a session

Start a new session with:

```text
We are starting step <N> of docs/roadmap.md. Read CLAUDE.md, the step's section in
docs/roadmap.md and the architecture sections it links to. Then go through the step's
"Decisions to make first" with me before writing any code.
```

---

## 1. Prompt service

**Goal:** Users store prompts with immutable versions, move Prompt Labels and compare versions,
through the REST API and the UI.

**Architecture:** [6. Prompts](architecture.md#6-prompts)

**Scope:**

- `services/prompt` with Prompts, Prompt Versions (numbered automatically, immutable) and Prompt
  Labels (movable).
- REST API: create a prompt, add a version, list versions, read a version by number or by label,
  move a label, compare two versions by text and model parameters.
- Gateway routes for the Prompt service and one combined OpenAPI document at `/v1/openapi.json`
  built from all services.
- UI: navigation between Traces and Prompts, prompt list, version history, version comparison.
- Authentication uses `STATIC_API_KEYS`, like Telemetry today. Move the API key parsing from
  `services/telemetry/src/projects/` to `packages/service-runtime` so both services share it until
  step 2 replaces it.
- CI and Compose: one PostgreSQL database per service. Rename `TELEMETRY_TEST_POSTGRES_URL` to a
  scheme that scales to more services.
- Housekeeping from step 0: record in `architecture.md` that `better-sqlite3` works on Linux x64
  (the first GitHub run passed), and pin the CI runner image, because `ubuntu-latest` moves to
  Ubuntu 26.

**Decisions to make first:**

- What a prompt version holds: plain text or a list of chat messages, template variable syntax,
  which model parameters are typed fields and which are free-form.
- How the combined OpenAPI document is built: merged at runtime by the Gateway or generated at build
  time.
- Whether the UI needs a router library now that it has more than one page.

**Done when:** a prompt can be created, versioned, labelled and compared in the UI and through the
API in both deployments.

## 2. Projects and API keys

**Goal:** Identity owns Projects and API keys, and Telemetry and Prompt validate API keys through
it. `STATIC_API_KEYS` disappears.

**Architecture:** [7. Access and security](architecture.md#7-access-and-security),
[Deleting a Project](architecture.md#deleting-a-project)

**Scope:**

- `services/identity` with Projects and Project API keys, stored hashed.
- An endpoint that resolves an API key to its Project. Telemetry and Prompt call it through
  `packages/service-client` and cache the answer for 60 seconds.
- First-start bootstrap: how a fresh Instance gets its first Project and API key, in both
  deployments.
- UI: Project list, creating a Project, creating and revoking API keys.
- A Project can be marked deleted, so access stops at once. Purging data is step 13.

**Decisions to make first:**

- Who may create Projects and API keys before users exist (step 3). One option is an Instance admin
  key from the environment, used only for bootstrap.
- API key format, for example a recognisable prefix plus random bytes, and whether the prefix is
  shown in the UI.
- What replaces `local-development-key` in the local image.

**Done when:** an API key created in the UI is accepted by OTLP ingestion and REST, and a revoked
key stops working within a minute, in both deployments.

## 3. Users, Groups, Roles and tokens

**Goal:** People sign in, belong to Groups and get Roles per Project. Services verify short-lived
JWTs locally and get their own tokens for service-to-service calls.

**Architecture:** [7. Access and security](architecture.md#7-access-and-security)

**Scope:**

- Users, Groups created locally, Role assignments (`viewer`, `editor`, `admin`) of a Group in a
  Project.
- Local accounts with password sign-in, only in the local image.
- Identity issues short-lived JWTs carrying Roles. `packages/service-runtime` verifies them locally.
  Every service enforces Roles on its REST endpoints.
- Service tokens: a service obtains a short-lived token for a Project from Identity.
- UI: sign-in page, Project switcher, Group and Role management. The UI no longer asks for an API
  key.
- Replace the Instance admin key from step 2 with Roles for managing Projects and API keys, and
  require a service token on Identity's internal API key resolution, which relies on network
  isolation until then.

**Decisions to make first:**

- Signing algorithm and how services get the public key: a JWKS endpoint on Identity, or a key
  shared through configuration.
- How a service authenticates itself to Identity when asking for a service token.
- Whether REST clients such as CI scripts keep using API keys or switch to tokens.
- How production signs users in before OIDC exists in step 9.

**Done when:** a `viewer` can read but not change data, an `editor` can change it, an `admin` can
manage Roles, and a service token lets one service read another's data for one Project, in both
deployments.

## 4. Datasets and Client-Driven Execution

**Goal:** A customer script runs a Dataset of Trace Test Cases against its own application, and the
platform judges each Output with Regex Evaluators.

**Architecture:** [5. Evaluation](architecture.md#5-evaluation),
[ADR 0001](adr/0001-pg-boss-for-evaluation-job-queue.md)

**Scope:**

- `services/evaluation` with `main-api.ts` and `main-worker.ts`, scaled separately.
- A job queue interface with pg-boss in production and a small SQLite queue in the local image.
  Verify pg-boss in a container, as ADR 0001 asks.
- Datasets and Test Cases with trace scope, Iterations, Pass Threshold.
- Client-Driven Execution: the script fetches Test Cases and reports each Iteration's Output and
  Correlation ID.
- Regex Evaluator, run in a Web Worker that is terminated on timeout.
- Results: `passed`, `failed`, `error`, two retries for an Error, run verdicts that never change
  after the run finishes.
- UI: Datasets, Test Cases, Evaluation Run list and run detail.
- An example script in `examples/` for TypeScript and Python.

**Decisions to make first:**

- The Test Case schema: input, expected values, Evaluator configuration, Iteration count.
- The Client-Driven Execution API: how a script starts a run, fetches Test Cases, reports Iterations
  and finishes the run.
- What a retry means in Client-Driven Execution, where the platform cannot repeat the call itself.

**Done when:** the example script runs a Dataset and the run's results appear in the UI, in both
deployments.

## 5. Trace completion and Telemetry Evaluator

**Goal:** The worker waits until an Iteration's trace is complete, rejects mixed telemetry and
judges spans with Telemetry Evaluators.

**Architecture:** [When a trace is complete](architecture.md#when-a-trace-is-complete),
[Protection against mixed telemetry](architecture.md#protection-against-mixed-telemetry),
[ADR 0003](adr/0003-independent-services-without-a-broker.md)

**Scope:**

- Telemetry API additions the worker needs: when the root span was stored, when the platform first
  received telemetry for a Correlation ID or `session.id`, and a flag on spans that arrive after
  evaluation.
- Polling every 2 seconds, the 10-second root-span rule and the 60-second timeout, both
  configurable.
- Protection against mixed telemetry.
- Telemetry Evaluator for Trace Test Cases.
- Results keep a summary of the matched spans, so they stay readable after retention expires.
- UI: span matches in the run detail, link from a result to its trace.

**Decisions to make first:**

- The Telemetry Evaluator's condition language: which span fields and attributes it can test, and
  how a condition is written.
- How the worker marks spans as evaluated, given that it may only use Telemetry's API.

**Done when:** a Telemetry Evaluator passes or fails on real spans, a missing root span ends the
Iteration as Error, and a reused Correlation ID is rejected, in both deployments.

## 6. Server-Driven Execution and Session Test Cases

**Goal:** The worker calls the user's Target itself, and Test Cases can cover a whole Session.

**Architecture:** [Execution modes](architecture.md#execution-modes),
[One Session Test Case Iteration](architecture.md#one-session-test-case-iteration),
[Secrets](architecture.md#secrets), [Known risks](architecture.md#known-risks-to-design-for)

**Scope:**

- Targets with credentials encrypted by AES-256-GCM. The master key comes from the environment, and
  the local image generates it into `/data` on first start.
- Left over from step 3: encrypt Identity's private signing key in its database with the master key,
  so that reading the database is no longer enough to sign access tokens. See the consequences in
  [ADR 0008](adr/0008-project-scoped-access-tokens-signed-by-identity.md).
- An allowlist of destinations the worker may call.
- Session Test Cases with several steps, in both execution modes, for the Regex and Telemetry
  Evaluators.
- UI: Target management, Session Test Case editor, Transcript in the run detail.

**Decisions to make first:**

- The HTTP contract between the worker and a Target: request and response shape, how the Target
  returns the Output, Correlation ID and `session.id`.
- How a Session Test Case defines its steps.
- The allowlist format and its default.

**Done when:** a multi-step Session Test Case runs against a sample Target in `examples/` and its
spans are judged across the whole Session, in both deployments.

## 7. LLM providers, Grading Evaluator and LLM Summary

**Goal:** An LLM judges Outputs and Transcripts, and every finished run gets an LLM Summary.

**Architecture:** [Evaluators](architecture.md#evaluators),
[LLM providers](architecture.md#llm-providers)

**Scope:**

- Provider adapters with declared capabilities: OpenAI-compatible (including Azure and local
  models), Anthropic, and TypeSafe Jev.
- Provider keys encrypted like Target credentials.
- Grading Evaluator referencing a Prompt Version, read from the Prompt service with a service token.
- LLM Summary with a default prompt or the user's own Prompt Version.
- Tests use a fake provider. Real providers are covered by optional tests that run only when keys
  are present.
- UI: provider management, Grading Evaluator configuration, the LLM Summary on the run page.

**Decisions to make first:**

- TypeSafe Jev's API and how its state and typed questions map to a Grading Evaluator's
  configuration. Research this before the session.
- The structured verdict format a Grading Evaluator asks the LLM for.

**Done when:** a Grading Evaluator judges a Transcript with a fake provider in CI and with a real
provider locally, and a finished run shows its LLM Summary.

## 8. Reports

**Goal:** A finished Evaluation Run sends a Report by email or to Teams.

**Architecture:** [Reports](architecture.md#reports)

**Scope:**

- Email over the customer's SMTP server and Teams through a Workflows webhook.
- Per Project: "always" or "only on failure".
- Delivery through the job queue with retries that never change the run's result.
- UI: Report settings per Project, delivery status on the run page.

**Decisions to make first:**

- The Report's content and format for each channel.

**Done when:** a finished run delivers a Report to a local SMTP test server and a fake webhook in
e2e tests.

## 9. OIDC sign-in

**Goal:** People sign in through the company's identity provider.

**Architecture:** [Identity](architecture.md#identity)

**Scope:**

- OIDC authorization code flow with PKCE, users created on first sign-in.
- Group claims mapped to Groups.
- An e2e test against a local OIDC provider in a container.
- Left over from step 3, for local accounts if they stay: protection against guessing passwords (a
  rate limit per account and per address, or a temporary lockout), and changing one's own password,
  which today only an Instance admin can do through `PATCH /v1/users/{userId}`.

**Decisions to make first:**

- Which OIDC provider runs in CI.
- Whether local accounts can coexist with OIDC in production, for example for a break-glass admin.

**Done when:** a user signs in through the CI's OIDC provider and receives the Roles of their
Groups.

## 10. SCIM and file import

**Goal:** Users and Groups stay in sync with the company's directory between sign-ins.

**Architecture:** [Identity](architecture.md#identity)

**Scope:**

- SCIM 2.0 Users and Groups endpoints.
- JSON and CSV import for companies without SCIM.
- Mapping a company group to a Group. Permissions are never imported.
- UI: import, mapping and sync status.

**Decisions to make first:**

- What happens to a user removed from the directory: deactivated or deleted, and what happens to
  their data.

**Done when:** SCIM requests and a CSV file create, update and deactivate users and Group
memberships.

## 11. Logs

**Goal:** Telemetry ingests, stores and queries OTLP logs.

**Architecture:** [4. Telemetry](architecture.md#4-telemetry)

**Scope:**

- OTLP logs over HTTP (protobuf and JSON) and gRPC.
- `correlation.id` required on logs with a `trace_id`, rejected through `partial_success` otherwise.
  Logs without a `trace_id` are stored as uncorrelated.
- Queries: time range, attribute filters, full-text search.
- The rejected count shown in the UI, for spans and logs.
- UI: log search, logs shown with their trace.

**Decisions to make first:**

- Full-text search on both databases: PostgreSQL `tsvector` and SQLite FTS5, or plain `LIKE` for
  now.
- Table layout that will survive 5,000 records per second and retention deletes, for example
  partitioning by time on PostgreSQL.

**Done when:** logs sent by the OTel SDK can be searched in the UI and through the API, in both
deployments.

## 12. Metrics

**Goal:** Telemetry ingests OTLP metrics and answers simple aggregation queries.

**Architecture:** [4. Telemetry](architecture.md#4-telemetry)

**Scope:**

- OTLP metrics over HTTP and gRPC: sums, gauges and histograms.
- Queries: metric, filters, `sum`, `avg`, `rate`, `p95`, grouping.
- UI: a query builder and an ECharts chart.

**Decisions to make first:**

- Which metric types and temporalities v1 accepts, and what it does with the rest.
- How `p95` is computed from histograms on both databases.

**Done when:** metrics from the OTel SDK appear as a chart with grouping, in both deployments.

## 13. Retention and Project deletion

**Goal:** Old telemetry disappears after the Project's retention period, and a deleted Project's
data disappears from every service.

**Architecture:** [Deleting a Project](architecture.md#deleting-a-project),
[Queries](architecture.md#queries)

**Scope:**

- Retention per Project, 30 days by default, for traces, logs and metrics.
- Each service periodically asks Identity for deleted Projects and removes their data.
- UI: retention setting, deletion progress per service.
- The UI shows that a trace is no longer available when a result refers to expired telemetry.

**Decisions to make first:**

- How services that have no job queue, such as Telemetry, schedule background work, and how that
  stays safe when several replicas run.

**Done when:** expired telemetry and a deleted Project's data are gone from every service, in both
deployments.

## 14. Helm chart

**Goal:** One Helm chart deploys every service to Kubernetes and OpenShift.

**Architecture:** [9. Deployment](architecture.md#9-deployment)

**Scope:**

- `deploy/helm` with one image per service, the customer's PostgreSQL, non-root containers with an
  arbitrary UID, and the master key from a Kubernetes Secret.
- OTLP/gRPC behind an L7 load balancer.
- CI installs the chart into a local cluster such as kind and runs the e2e tests against it.
- Published images on `ghcr.io` with one version set.
- Left over from step 3: rotating Identity's signing key. Services already read the keys again for
  an unknown key ID; what is missing is adding a new key, choosing which key signs, and removing the
  old one after the longest token lifetime.

**Decisions to make first:**

- Ingress versus OpenShift Route, and how the chart supports both.
- How database migrations run during an upgrade: an init container or a Helm hook.

**Done when:** the e2e tests pass against the chart in CI.

## 15. Nightly performance test and module boundaries

**Goal:** A nightly run catches performance regressions, and CI checks the remaining import rule.

**Architecture:** [11. Quality](architecture.md#11-quality)

**Scope:**

- `tests/performance/` with a nightly GitHub Actions workflow on a standard runner, comparing
  ingestion throughput and query latency with the previous run.
- pg-boss under sustained load, as ADR 0001 asks.
- An architecture test that modules inside a service import each other only through their public
  entry points.
- Done early: browser tests of the main UI flows in `tests/e2e/web-ui.test.ts`, see
  [ADR 0005](adr/0005-playwright-browser-tests-with-layout-rules.md).

**Decisions to make first:**

- Where results are stored between nightly runs and what counts as a regression.

**Done when:** the nightly workflow runs and fails on a deliberate regression, and both new
architecture checks run in CI.
