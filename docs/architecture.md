# Architecture

**Status:** accepted on 2026-11-06, including the repository structure.

Extispex is a self-hosted platform for observing and evaluating GenAI applications and agents. Terms
in this document are defined in [GLOSSARY.md](../GLOSSARY.md). The original requirements are in
[business.md](business.md).

## 1. Scope

**In v1:**

- OTLP ingestion of traces, logs and metrics, with a public REST API and a web UI
- Datasets, Evaluation Runs, Evaluators, LLM Summaries and Reports
- Versioned prompts
- Projects, Groups and Roles, with users imported from the company's identity system
- A scalable production deployment and a single-image local deployment

**Not in v1:**

- Hosting several companies on one Instance
- A replacement for infrastructure monitoring: PromQL, alerting and custom dashboards
- A built-in scheduler for Evaluation Runs: customers trigger runs from their own CI or cron
- Evaluation of production traffic: only Evaluation Runs are evaluated
- LLM-simulated users in Session Test Cases
- Vault integrations and Terraform modules

**Capacity target:** 5,000 spans per second per Instance, with 30 days of retention by default. This
is an assumption that has not been measured, because performance tests are deferred (see
[Quality](#11-quality)).

## 2. System overview

```mermaid
flowchart LR
  app["User's application<br/>OTel SDK"]
  browser["Browser"]
  client["Customer scripts and CI"]
  company["Company identity system"]

  subgraph instance["Instance"]
    gateway["Gateway + UI"]
    telemetry["Telemetry"]
    evaluation_api["Evaluation API"]
    evaluation_worker["Evaluation worker"]
    prompt["Prompt"]
    identity["Identity"]
  end

  app -- "OTLP" --> telemetry
  browser --> gateway
  client -- "REST" --> gateway
  gateway --> telemetry
  gateway --> evaluation_api
  gateway --> prompt
  gateway --> identity
  company -- "OIDC, SCIM, file import" --> identity
  telemetry -- "public keys, service token, API key resolution cached 60 s" --> identity
  prompt -- "public keys, service token, API key resolution cached 60 s" --> identity
  evaluation_api -- "public keys, service token, API key resolution cached 60 s" --> identity
  evaluation_worker -- "service token for a Project" --> identity
  evaluation_worker -- "read traces and sessions" --> telemetry
  evaluation_worker -- "read Prompt Versions" --> prompt
  evaluation_worker -- "call Target" --> app
```

| Service          | Owns                                                                   | Deployed as                                         |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| **Telemetry**    | OTLP ingestion, traces, logs, metrics, Sessions, retention             | One scalable service for both ingestion and queries |
| **Evaluation**   | Datasets, Test Cases, Evaluation Runs, results, LLM providers, Reports | API and worker, scaled separately                   |
| **Prompt**       | Prompts, Prompt Versions, Prompt Labels                                | API                                                 |
| **Identity**     | Users, Groups, Projects, Role assignments, API keys, tokens            | API                                                 |
| **Gateway + UI** | Entry point for REST and the UI, combined OpenAPI document             | Proxy and static web app                            |

### Service rules

- A service changes only its own data and reaches other services only through their contracts.
- Services never read another service's tables.
- Each service has its own logical database and connection string. By default, one PostgreSQL server
  hosts all four databases. Telemetry can move to its own server through configuration alone.
- There is no event broker in v1. Services communicate through synchronous HTTP calls, and the job
  queue is private to Evaluation. See [ADR 0003](adr/0003-independent-services-without-a-broker.md).

### Deleting a Project

1. Identity marks the Project as deleted, so access stops at once.
2. Each service periodically asks Identity for deleted Projects and removes their data.
3. The UI shows deletion progress for each service.

## 3. Technology

| Concern                | Choice                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and language   | Deno, TypeScript                                                                                                                            |
| HTTP and API contracts | Hono, `@hono/zod-openapi`                                                                                                                   |
| gRPC                   | `@grpc/grpc-js`                                                                                                                             |
| Persistence            | MikroORM, with PostgreSQL in production and SQLite in the local image, see [ADR 0002](adr/0002-postgresql-and-sqlite-instead-of-mongodb.md) |
| Job queue              | pg-boss in production and a small SQLite queue in the local image, see [ADR 0001](adr/0001-pg-boss-for-evaluation-job-queue.md)             |
| UI                     | React, React Router in declarative mode, Vite, ECharts                                                                                      |
| Browser tests          | `playwright-core` with headless Chromium, see [ADR 0005](adr/0005-playwright-browser-tests-with-layout-rules.md)                            |
| Delivery               | Docker images, Helm chart, GitHub Actions                                                                                                   |

## 4. Telemetry

### Ingestion

- OTLP is accepted as protobuf or JSON over HTTP and as protobuf over gRPC. OTLP/gRPC does not carry
  JSON, so JSON means HTTP only.
- Both protocols accept gzip and deflate, the encodings that OpenTelemetry SDKs and the Collector
  offer by default. OTLP/HTTP decompresses with `DecompressionStream` and answers any other
  `Content-Encoding` with `415` and an `Accept-Encoding` header. grpc-js decompresses OTLP/gRPC
  messages before the handler sees them.
- One export request may hold up to 32 MiB after decompression on both protocols, so a batch that
  one protocol accepts is never refused by the other. OTLP/HTTP counts bytes while it decompresses
  and stops at the limit, so a small compressed body cannot fill the memory. grpc-js also checks
  `grpc.max_receive_message_length` after decompression; its default of 4 MiB is raised to the same
  limit.
- OTLP traffic goes directly to Telemetry and bypasses the Gateway because of its volume and gRPC.
- The API key, or the access token's Project, on the request determines the Project.
- A batch is acknowledged only after it is stored. If the database cannot keep up, Telemetry returns
  a retryable response and the exporter retries. There is no intermediate buffer in v1.

### Correlation ID and Session

The user's application assigns both values. The platform never generates them.

| Attribute        | Applies to                             | Rule                                                                                                                                                                                                   |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `correlation.id` | Spans, and logs that have a `trace_id` | Required. Records without it are rejected through OTLP `partial_success`, and the rejected count is shown in the UI. A log without a `trace_id`, such as a startup message, is stored as uncorrelated. |
| `session.id`     | Spans                                  | Optional. A Session exists as soon as its first trace arrives.                                                                                                                                         |
| Neither          | Metrics                                | Not required, because a per-call value would make metric cardinality unmanageable.                                                                                                                     |

The check runs on every record because spans of one trace can arrive in different batches. A short
span processor in the application copies both values from OTel baggage onto every span. The
TypeScript helper package provides this, and `examples/` shows it in Python.

### Logs

Built in roadmap step 11. See [ADR 0012](adr/0012-daily-log-partitions-on-the-record-time.md) for
the table layout.

- **Time:** a Log Record's time is OTLP's `time_unix_nano`, or else `observed_time_unix_nano`, as
  OTLP advises, or else the receive time. A record more than 30 days old or more than one day ahead
  is rejected.
- **Correlation:** a Log Record with a `trace_id` needs `correlation.id`. OTLP says that a malformed
  `trace_id` means no trace, so such a record is stored as an Uncorrelated Log.
- **Retried batches:** OTLP has no ID for a Log Record, so its ID is the SHA-256 of its content. An
  exporter's retry stores nothing twice, and Loki also merges identical lines at one timestamp.
- **Storage:** PostgreSQL has daily partitions and a `tsvector` with the `simple` configuration.
  SQLite has one table and FTS5 keeping diacritics. Both index the first 65,536 characters of the
  body, because PostgreSQL refuses a `tsvector` above 1 MiB. Words are split slightly differently:
  PostgreSQL keeps a host name or an email address as one word, and SQLite splits it at punctuation.
- **Text that cannot be stored:** U+0000 and lone surrogates are removed from Log Records, because
  PostgreSQL refuses them and one such value would fail its batch on every retry.
- **Rejected records:** ingestion adds spans and Log Records it rejects to a count per Project,
  signal and hour. `GET /v1/rejected-telemetry` returns the last 24 hours, and the Traces and Logs
  pages show it. A count that cannot be written is logged and does not fail the export.

### Queries

- **Traces:** waterfall and span details, inspired by MLflow.
- **Logs:** time range, attribute filters and full-text search, inspired by Loggly. `GET /v1/logs`
  answers newest first with a `nextCursor`. `search` finds whole words in the body, all of them, and
  `attribute=key=value` may be repeated.
- **Metrics:** metric, filters, `sum`, `avg`, `rate`, `p95` and grouping, inspired by Grafana's
  query builder.
- **Retention:** configurable per Project, 30 days by default.

Telemetry storage sits behind its own interface, so another store such as ClickHouse can be added if
measurements show a need for it.

## 5. Evaluation

### Execution modes

Both modes share one contract: each step of an Iteration produces an `output`, a `correlationId` and
optionally a `sessionId`.

- **Server-Driven Execution:** the worker calls the Target.
- **Client-Driven Execution:** the user's script fetches Test Cases through the API, runs the
  application and reports the same three fields.

### One Session Test Case Iteration

```mermaid
sequenceDiagram
  participant Worker as Evaluation worker
  participant Target as Target
  participant Telemetry as Telemetry

  Worker->>Target: input "Where is my order?"
  Target-->>Telemetry: spans with chat-42 and c-1
  Target-->>Worker: output, sessionId chat-42, correlationId c-1
  Worker->>Target: input "Can I cancel it?", sessionId chat-42
  Target-->>Telemetry: spans with chat-42 and c-2
  Target-->>Worker: output, sessionId chat-42, correlationId c-2
  loop every 2 s until complete or timed out
    Worker->>Telemetry: GET traces by Correlation ID
  end
  Worker->>Telemetry: GET all spans by session.id
  Worker->>Worker: run Evaluators and store the result
```

### When a trace is complete

OTLP span delivery carries no end-of-trace signal, so established systems use timers. This design
follows Honeycomb Refinery's root-span rule, adapted for evaluation.

- A trace is complete when its root span has been stored for at least 10 seconds. The delay covers
  spans from other services, because OTel SDKs export batches every 5 seconds by default.
- If no root span arrives within 60 seconds after the application's Output, the Iteration ends as
  Error. Evaluating partial data could produce a false failure.
- Spans that arrive after evaluation are stored and flagged, and they do not change the verdict.
- A Session Test Case needs no idle timer, because its last step marks its end.

Both timers are configurable: `EVALUATION_ROOT_SPAN_SETTLE_MILLISECONDS` and
`EVALUATION_ROOT_SPAN_TIMEOUT_MILLISECONDS`, with Telemetry asked every
`EVALUATION_TELEMETRY_POLL_INTERVAL_MILLISECONDS` (2 seconds by default).

Built in roadmap step 5:

- **Only Test Cases with a Telemetry Evaluator wait.** An Output alone cannot be incomplete, so a
  Test Case with only Regex Evaluators is judged at once and needs no telemetry.
- **Several traces:** a Correlation ID can have several traces, for example after a retry. Each one
  needs a root span, and the latest root span must have been stored for 10 seconds. A root span that
  arrives just before the timeout still gets its full 10 seconds.
- **No job waits in a worker slot.** A job that has to wait queues itself again with a delay, so
  waiting Iterations do not hold back the others. Its age comes from the stored time of the Output,
  so the job carries no state.
- **Clocks:** Telemetry answers with its own current time, `readAt`, so the 10 seconds are measured
  on one clock.
- **Telemetry unavailable:** the attempt keeps waiting until the 60-second timeout, then ends as
  Error.
- **Telemetry's internal API** is `GET /internal/v1/correlations/{id}`, `.../spans`,
  `POST .../evaluated` and `GET /internal/v1/sessions/{id}`. The Gateway does not forward them.
  Telemetry's port is open to OTLP exporters, so they take only a service token for the Project. A
  user's token or an API key gets `401`, even with the Role `admin`.
- **Marking spans as evaluated:** the worker reports the `readAt` of the spans it judged, and
  Telemetry stores it per Correlation ID. A span received later has `arrivedAfterEvaluation`, which
  is worked out when reading, so spans are never rewritten.

### Protection against mixed telemetry

An Iteration ends as Error when its `session.id` or Correlation ID:

- already has telemetry that the platform received before the Iteration started, or
- is used by another Iteration of the same Evaluation Run.

Without this check, a reused Session could let an Iteration pass because of a tool call made by an
earlier Iteration. Comparing the platform's receive times avoids problems with skewed client clocks.
A retried Iteration is expected to produce new values.

Built in roadmap step 5, and applied to Test Cases with a Telemetry Evaluator:

- **When an attempt starts:** when the platform makes it available, which is the start of the run
  for the first attempt and the end of the previous attempt for a retry. Client-Driven Execution has
  no earlier signal, because handing out work is a repeatable read.
- **Other attempts:** the first rule's "another Iteration" includes the other attempts of the same
  Iteration, so a retry that repeats its IDs ends as Error. An ID found only after another Iteration
  has already been judged ends the later Iteration as Error and leaves the earlier result alone.

### Client-Driven Execution

Built in roadmap step 4. See [ADR 0009](adr/0009-client-driven-execution-as-a-pull-protocol.md) for
the reasons.

A Test Case holds what the script needs and how to judge the Output:

```json
{
  "name": "refund-mentions-30-days",
  "scope": "trace",
  "input": { "message": "What is your refund policy?" },
  "expectedOutput": "Refunds within 30 days.",
  "evaluators": [
    { "type": "regex", "name": "mentions-days", "pattern": "30\\s*days", "flags": "i" }
  ],
  "iterations": 3,
  "passThreshold": 0.66
}
```

- **Copies:** starting a run copies its Test Cases, so editing or deleting them never changes a run.
- **The script's loop:** `POST /v1/evaluation-runs`, `POST /v1/evaluation-runs/{id}/reports` and
  `GET /v1/evaluation-runs/{id}/work` all answer with `runId`, `status`, `verdict`, `items` and
  `evaluationsInProgress`. The script runs `items` and reports them, up to the run's `batchSize` of
  at most 100. With no `items` and the status `running`, it waits for the worker.
- **Attempts:** an Error, reported by the script or found by an Evaluator, puts the Iteration back
  into `items` with the next `attempt`, up to three in total. Each attempt is stored.
- **Reports** are handled one by one, and refused ones are listed in `rejected`. Repeating an
  identical report changes nothing.
- **The end of a run:** a run finishes when every Iteration has a result. `POST .../finish` ends it
  early, and a run without a report for 24 hours ends too
  (`EVALUATION_INACTIVE_RUN_TIMEOUT_MILLISECONDS`). Evaluations may take many hours, so the limit
  counts from the last report rather than from the start. Open Iterations then end as Error, without
  retries. The run's verdict is `failed` on any failure, otherwise `error` on any Error, otherwise
  `passed`.
- **Results** are paged, so their size does not grow with the run. `GET /v1/evaluation-runs/{id}` is
  the run's state, `.../test-cases` a page of Test Case results, and
  `.../test-cases/{name}/iterations` a page of one Test Case's Iterations with their attempts. A
  page holds at most 50 entries and gives a `nextCursor`.
- **Concurrency:** every change to a run first increments its `revision`, which locks the row until
  commit, so exactly one transaction sees the last Iteration end and sets the verdicts.
- **Job queue:** the API stores a report first and queues its job afterwards. A job can be lost
  between the two, so the worker queues attempts again after two minutes, and judging an attempt
  twice changes nothing. pg-boss keeps its tables in its own schema of the Evaluation database. The
  local image polls a table in its SQLite file.
- **Regular expressions** run in a new Web Worker that is terminated after one second
  (`EVALUATION_REGEX_TIMEOUT_MILLISECONDS`). A timeout is an Error.

### Evaluators

| Evaluator     | Trace Test Case           | Session Test Case                                                      |
| ------------- | ------------------------- | ---------------------------------------------------------------------- |
| **Regex**     | The Output                | The last Output by default, or any step                                |
| **Grading**   | The prompt and Transcript | The prompt and whole Transcript. Spans are added only when configured. |
| **Telemetry** | Spans of that trace       | Spans of all traces with that `session.id`                             |

A Telemetry Evaluator counts the spans that meet its conditions, see
[ADR 0010](adr/0010-telemetry-evaluator-conditions-as-json.md):

```json
{
  "type": "telemetry",
  "name": "called-refund-tool",
  "match": {
    "name": "execute_tool",
    "status": "ok",
    "attributes": { "gen_ai.tool.name": "lookup_refund" }
  },
  "count": { "min": 1 }
}
```

`name`, `status` and `attributes` are each optional, but one is required, and attribute values are
compared exactly. `count` defaults to at least one, and `{ "min": 0, "max": 0 }` forbids such a
span. More than 10,000 spans for one Correlation ID make the attempt an Error, because judging part
of them could produce a false failure.

### Results

- An Iteration is `passed`, `failed` or `error`. It passes only if all its Evaluators pass.
- An Iteration with an Error is retried up to two times. If the Error persists, the Test Case ends
  as `error`: it does not count as a failure, but the Evaluation Run is not successful.
- A Test Case passes when the share of passed Iterations reaches its Pass Threshold, which defaults
  to 100%.
- Results keep a copy of everything needed to display them: Output, verdict, reason, the text of the
  Prompt Version, Correlation ID and a summary of matched spans. They stay readable after telemetry
  retention expires, and the UI then shows that the trace is no longer available.
- A finished run's verdicts never change.

### LLM providers

Providers declare capabilities: **Text Generation** and **Judgment**. V1 includes OpenAI-compatible
(including Azure and local models), Anthropic and TypeSafe adapters. TypeSafe Jev accepts a state
and typed questions, not free-form prompts, so a Grading Evaluator using it has its own
configuration. LLM Summaries need Text Generation.

### Reports

When an Evaluation Run ends, Evaluation can send a Report by email over the customer's SMTP server,
or to Teams through a Workflows webhook. Each Project chooses "always" or "only on failure".
Delivery failures are retried through the job queue and never change the run's result.

## 6. Prompts

Prompt Versions are immutable and numbered automatically. Prompt Labels such as `production` can
move between versions. Versions can be compared by text and model parameters. Evaluators and LLM
Summaries reference a specific version, so a run can be repeated.

### What a Prompt Version holds

A prompt is identified by its name, which is unique within its Project and never changes, so an
application reads `GET /v1/prompts/support-agent/labels/production`. A version holds either one text
or a list of chat messages with the roles `system`, `user` and `assistant`, as Langfuse and MLflow's
prompt registry do.

```json
{
  "type": "chat",
  "messages": [
    { "role": "system", "content": "You help customers of {{company}}." },
    { "role": "user", "content": "{{question}}" }
  ],
  "modelParameters": {
    "model": "gpt-4.1",
    "temperature": 0.2,
    "maxOutputTokens": 800,
    "topP": null,
    "providerOptions": { "response_format": { "type": "json_object" } }
  },
  "variables": ["company", "question"],
  "commitMessage": "Shorter system prompt"
}
```

- **Prompt Variables** are written `{{name}}`, as in Langfuse, MLflow and the OpenAI and Anthropic
  consoles. They are only replaced by values: there are no conditions or loops, so a template cannot
  run logic. The service lists each version's variables when it stores it.
- **Model parameters** have typed fields for what every LLM provider understands: `model`,
  `temperature`, `maxOutputTokens` and `topP`. The Grading Evaluator maps them to each provider in
  step 7. Anything provider-specific goes into `providerOptions`, stored as given. Unknown fields
  outside `providerOptions` are rejected, so that a misspelt parameter is not silently dropped.
- **Numbering:** adding a version increments a counter on the prompt in the same transaction, so
  concurrent additions get distinct numbers on both databases.
- **Comparison:** `GET /v1/prompts/{name}/compare?fromVersion=1&toVersion=2` first matches whole
  messages, so that an inserted message does not make every later one look changed, then compares
  messages that differ at the same position with the same role line by line. Model parameters are
  compared one by one, including each provider option.

### Public API document

The public API's routes are defined in `packages/contracts`. Each service attaches its handlers to
those definitions, and the Gateway builds its forwarding table and the combined OpenAPI document at
`/v1/openapi.json` from the same list, see
[ADR 0006](adr/0006-public-api-routes-in-shared-contracts.md).

## 7. Access and security

### Identity

- **OIDC** signs users in.
- **SCIM 2.0** keeps users and Groups in sync between sign-ins.
- **JSON or CSV import** serves companies without SCIM.
- **Local accounts** sign in with a password that Identity stores. The local image always enables
  them; the separate Identity service enables them with `LOCAL_ACCOUNTS=enabled`, and they are off
  by default there. In production they are the break-glass way in when the identity provider is
  unavailable.
- Permissions are not imported. A company's group is mapped to a Group, and a Project admin assigns
  it a Role: `viewer`, `editor` or `admin`.

### Requests

- **UI and REST:** Identity issues short-lived access tokens, JWTs scoped to at most one Project and
  carrying the caller's Role there. Each service verifies them locally. See
  [ADR 0008](adr/0008-project-scoped-access-tokens-signed-by-identity.md).
- **Scripts and OTLP:** a Project API key, which Telemetry, Prompt and Evaluation resolve through
  Identity and cache for 60 seconds, so a revocation takes effect within a minute. An API key acts
  as `editor`.
- **Service to service:** each service obtains a short-lived service token from Identity. The worker
  uses one per Project to read Telemetry and Prompt data for the Project it is evaluating.

### Users, Groups, Roles and tokens

Built in roadmap step 3.

```mermaid
sequenceDiagram
  participant browser as Browser
  participant identity as Identity
  participant service as Prompt or Telemetry
  browser->>identity: POST /v1/sign-in {email, password}
  identity-->>browser: Set-Cookie extispex_sign_in (HttpOnly, SameSite=Strict, Path=/v1/sign-in)
  browser->>identity: POST /v1/sign-in/access-tokens {projectId} + cookie
  identity-->>browser: {accessToken: JWT for 5 minutes, role}
  browser->>service: GET /v1/prompts, Authorization: Bearer JWT
  service->>service: verify the signature with Identity's cached public keys
  service-->>browser: the Project's prompts
```

- **Roles:** a `viewer` reads a Project's data, an `editor` also changes it, an `admin` also manages
  the Project's Role assignments and API keys. A user gets the highest Role of their Groups in the
  Project. Services check the Role: reading takes `viewer`, every change `editor`.
- **Instance admins** create Projects, users and Groups, and manage any Project's Role assignments.
  They read a Project's data only through a Role. The first administrator is an Instance admin in
  the Group `Administrators`, which gets the Role `admin` in every Project that exists at first
  start. The Instance always keeps at least one active Instance admin.
- **Access tokens:** ES256 JWTs with `sub` (`user:<id>` or `service:<client id>`), and `project` and
  `role` when scoped to a Project. They last five minutes, so a removed Role or a deactivated user
  loses access to other services within five minutes. Identity's own endpoints read the user from
  its database on every request, so a change applies there at once. A token without a Project
  manages access only and reaches no Project's data.
- **Signing keys:** Identity creates a P-256 key pair on its first token and keeps it in its
  database, so every replica signs with the same key. Services read the public keys from
  `GET /internal/v1/jwks.json`, keep them in memory, and read them again for a token with an unknown
  key ID, at most every 30 seconds. Rotation is not built; the key ID allows adding it.
- **Sign-in:** the cookie holds 256 random bits, and Identity stores only their SHA-256 hash. A
  sign-in ends after 12 hours without a new access token, or when the user signs out or is
  deactivated. The cookie is `Secure` when the browser used HTTPS, which the Gateway passes in
  `X-Forwarded-Proto`. The UI keeps access tokens in memory only. Passwords are PBKDF2-HMAC-SHA256
  hashes with 600,000 iterations, as OWASP advises; WebCrypto computes them without a dependency.
- **Service tokens:** a service authenticates with the OAuth 2.0 client credentials grant: its
  client ID and secret from `SERVICE_CLIENTS` in Identity and `IDENTITY_CLIENT_SECRET` in the
  service, sent as HTTP Basic to `POST /internal/v1/service-tokens`. A token for a Project carries
  `viewer`; one without a Project calls Identity's internal API, such as API key resolution. The
  all-in-one process generates its services' secrets in memory. Services keep a token until a minute
  before it expires.
- **Gateway:** forwards cookies only to Identity, so the sign-in cookie never reaches another
  service.

### OIDC sign-in

Built in roadmap step 9. See [ADR 0011](adr/0011-oidc-users-identified-by-issuer-and-subject.md) for
why a user is found by issuer and subject and how Groups follow Company groups.

```mermaid
sequenceDiagram
  participant browser as Browser
  participant identity as Identity
  participant provider as Identity provider
  browser->>identity: GET /v1/sign-in/oidc/authorize?returnTo=/traces
  identity-->>browser: 302 to the provider, state, nonce, S256 code_challenge, cookie extispex_oidc_attempt
  browser->>provider: The company's sign-in page
  provider-->>browser: 302 to /v1/sign-in/oidc/callback?code=…&state=…
  browser->>identity: GET the callback + cookie extispex_oidc_attempt
  identity->>provider: POST the token endpoint with the code, code_verifier and client secret
  provider-->>identity: ID token
  identity->>identity: verify it, find or create the user, follow the Company groups
  identity-->>browser: 302 to /traces, Set-Cookie extispex_sign_in
```

- **Identity is the client.** It is confidential and uses the authorization code flow with PKCE
  through `openid-client`. The provider's tokens never reach the browser, which afterwards holds the
  same sign-in cookie as after a password.
- **An attempt** is a row found by the hash of `state`, holding the nonce and code verifier. A
  second value in the `SameSite=Lax` cookie `extispex_oidc_attempt` ties it to the browser that
  started it, it lasts ten minutes and it works once. It is a row and not a cookie, so that any
  replica can complete it and nothing secret is sent to the browser.
- **Configuration** is `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and
  `OIDC_REDIRECT_URL`, and optionally `OIDC_SCOPES`, `OIDC_GROUPS_CLAIM` (default `groups`),
  `OIDC_PROVIDER_NAME` and, for development without TLS, `OIDC_ALLOW_INSECURE_HTTP=enabled`.
  Identity reads the provider's discovery document on the first sign-in, so a provider that is down
  does not stop it from starting.
- **A user** gets the email and name of each sign-in. An address that the provider says it has not
  verified is refused, and one held by another user refuses a first sign-in.
- **Failures** redirect to the UI with `signInError`, because the browser arrives by navigating.
- **The Gateway** does not follow redirects, so each reaches the browser.
- **Signing out** ends the Extispex sign-in only. The browser stays signed in at the provider.

### Guessing passwords

Built in roadmap step 9. A password attempt counts against the account and against the browser's
address before the hash is computed, in fixed windows of 15 minutes kept in the database: at most 10
per account and 100 per address, then `429` with `Retry-After`. A right password forgets the
account's attempts and takes back its own on the address. An unknown email counts like a known one,
so the answer does not reveal who has an account. Changing one's own password counts the same way
and ends the user's other sign-ins.

The Gateway passes the browser's address to Identity in `X-Forwarded-For`. Without proxies in front
of it that is the connection's peer. Behind them, `GATEWAY_TRUSTED_PROXY_COUNT` says how many
entries from the right are real, so a client cannot choose its own address.

### Projects and API keys

Built in roadmap step 2. Identity owns Projects and their API keys; Telemetry and Prompt only ask it
which Project a key belongs to.

- **Key format:** `extispex_` followed by 43 base62 characters, 256 random bits. The prefix lets
  people and secret scanners recognise a key. Identity stores the key's SHA-256 hash and its first
  17 characters, which the UI shows to tell keys apart. The full key is returned once, when it is
  created. See [ADR 0007](adr/0007-prefixed-api-keys-resolved-through-identity.md).
- **Resolution:** Telemetry and Prompt call `POST /internal/v1/api-keys/resolve` through
  `packages/service-client` with the key in the body. `packages/service-runtime` caches each answer,
  positive or negative, for 60 seconds, keyed by the key's hash, and lets concurrent requests with
  the same key share one call. A revoked key, or any key of a deleted Project, therefore stops
  working within a minute.
- **Identity unavailable:** a key that is not cached gets `503` with `Retry-After` on HTTP and
  `UNAVAILABLE` on gRPC. OTLP exporters retry both, so spans are not lost during a short outage.
- **Internal endpoints:** the Gateway does not forward `/internal/` paths, because they are not in
  the shared contracts. API key resolution takes a service token since step 3. Identity's port is
  still not published, in Compose either: the public keys need no authentication, and the service
  token endpoint should not be exposed to guessing.
- **Managing** Projects and API keys took an Instance admin key from the environment in step 2.
  Since step 3, an Instance admin creates and deletes Projects, and a Project's `admin` manages its
  API keys.
- **First start:** when the Instance has no Project at all, Identity creates the Project `Default`
  with the key from `BOOTSTRAP_PROJECT_API_KEY`. The local image generates that key when the
  variable is not set and logs it once. Separate services without the variable start with no
  Project; an Instance admin creates one in the UI. Several replicas starting at once create one
  Project, because the name is unique among Projects that are not deleted.
- **Deleting a Project** sets its deletion time. Its keys stop resolving at once and it disappears
  from the list; purging its data in every service is step 13.

### Secrets

LLM provider keys and Target credentials are encrypted in the Evaluation database with AES-256-GCM.
The master key comes from a Kubernetes Secret or environment variable. The local image generates it
into `/data` on first start.

### Known risks to design for

- **Requests to internal addresses:** Targets are user-supplied URLs, so the worker could be pointed
  at internal services. It needs an allowlist of permitted destinations.
- **Slow regular expressions:** user-supplied patterns can run for a long time. They need to run in
  a Web Worker that can be terminated on timeout.

## 8. Web UI

The UI is a React single-page application with English text that talks only to the Gateway.
Observability and evaluation share one interface.

## 9. Deployment

### Production

- One image per service, deployed by one Helm chart to OpenShift, AKS or EKS.
- The customer provides PostgreSQL. The chart does not install it.
- Containers run as non-root with an arbitrary UID, as OpenShift requires by default.
- gRPC holds long-lived HTTP/2 connections, so OTLP/gRPC needs an L7 load balancer or client-side
  balancing.
- All services ship as one version set. Within `/v1`, contract changes must be backward compatible
  so that rolling updates work.

### Local image

The `all-in-one` image has no external dependencies. All services run in one process, each with its
own SQLite file in `/data`. Calls between services reuse the same request handlers without a
network:

```ts
// Production: Evaluation calls Telemetry over the network
const telemetryClient = createHttpClient(environment.TELEMETRY_URL);

// Local image: the same contract without a network
const telemetryService = createTelemetryService({ databasePath: "/data/telemetry.sqlite" });
const telemetryClient = createInProcessClient(telemetryService.handleRequest);
```

## 10. Repository structure

Approved on 2026-11-06. The repository is one Deno workspace.

```text
.
├── CLAUDE.md
├── GLOSSARY.md
├── README.md
├── deno.json
├── services/
│   ├── telemetry/
│   │   ├── src/
│   │   │   ├── main.ts              # Starts the service on its own
│   │   │   ├── create-service.ts    # Builds the service from its dependencies
│   │   │   ├── ingestion/
│   │   │   ├── traces/
│   │   │   ├── logs/
│   │   │   ├── metrics/
│   │   │   ├── sessions/
│   │   │   ├── retention/
│   │   │   └── storage/
│   │   ├── migrations/
│   │   │   ├── postgres/
│   │   │   └── sqlite/
│   │   └── tests/
│   ├── evaluation/
│   │   └── src/
│   │       ├── main-api.ts
│   │       ├── main-worker.ts
│   │       ├── create-service.ts
│   │       ├── datasets/
│   │       ├── evaluation-runs/
│   │       ├── iterations/
│   │       ├── evaluators/
│   │       ├── targets/
│   │       ├── llm-providers/
│   │       ├── reports/
│   │       └── job-queue/
│   ├── prompt/
│   ├── identity/
│   └── gateway/
├── apps/
│   ├── web/                         # React UI
│   └── all-in-one/                  # Local image: runs all services in one process
├── packages/
│   ├── contracts/                   # API schemas for each service
│   ├── service-client/              # HTTP and in-process clients
│   ├── service-runtime/             # Shared config, logging, HTTP app and token verification
│   ├── service-storage/             # Opening a service's database and running its migrations
│   └── telemetry-ids/               # Public helper for Correlation ID and session.id
├── examples/
│   ├── typescript/
│   └── python/
├── tests/
│   └── e2e/
├── deploy/
│   ├── docker/
│   ├── compose/
│   └── helm/
├── docs/
│   ├── business.md
│   ├── architecture.md
│   └── adr/
└── .github/workflows/
```

Import rules, enforced in CI:

- A service may import `packages/*`, but never another service.
- Modules inside a service import each other only through their public entry points.
- Only `apps/all-in-one` may import several services, and only their `create-service.ts`.
- `packages/` holds contracts and technical helpers, never domain logic.

## 11. Quality

This repository's GitHub Actions pipeline runs on every pull request. It checks lint, formatting,
types and import rules, runs unit tests on SQLite and PostgreSQL, runs e2e tests in both
deployments, and builds the container images and runs the e2e tests against the `all-in-one` image.
The e2e tests include browser tests of the web UI's main flows and layout rules.

Performance tests follow one rule: they run only where GitHub Actions is free.

- **Nightly regression test:** planned, not yet implemented. It runs on a standard runner, which is
  free because the repository is public. It will live in `tests/performance/`.
- **Capacity check on a dedicated machine:** deferred, because larger runners are never free.

Code, tests, examples, documentation and operations are written in English. Names must state their
purpose, and single-letter names are not allowed.

### What has been verified

These small tests ran on 2026-11-04 on macOS with Deno 2.9.5. They show that the pieces work
together. They are not benchmarks.

| Tested                                                             | Result                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| gRPC server with `@grpc/grpc-js` 1.14 and a Node client            | Unary calls, a 3 MB payload, error status and 2,000 concurrent calls worked, locally and without TLS                                 |
| MikroORM 7.2.6 on PostgreSQL and SQLite                            | One entity worked on both, including JSON attribute filters and grouping                                                             |
| MikroORM 7.2.6 on MongoDB                                          | Filtering on a dotted attribute such as `gen_ai.request.model` silently returned no records, and grouping needed a separate pipeline |
| pg-boss 12.38 and BullMQ 6.5.4                                     | Both processed all jobs with a retry, see [ADR 0001](adr/0001-pg-boss-for-evaluation-job-queue.md)                                   |
| Correlation ID and Session propagation with an OTel span processor | All 6 spans in 2 traces reached a local OTLP receiver with the right values                                                          |
| Hono handler over HTTP and called directly                         | Same response on one endpoint, with validation and OpenAPI 3.1 generation                                                            |
| React 19 and Vite 7 build                                          | A minimal page built successfully                                                                                                    |

The first implementation step added these checks on 2026-11-06. They run as automated tests in this
repository.

| Tested                                                         | Result                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| OTel JS exporters over HTTP/protobuf, HTTP/JSON and gRPC + TLS | Spans stored and readable through the Gateway, in all-in-one and in separate services  |
| `better-sqlite3` in the `all-in-one` image                     | Works on Linux arm64, run as an arbitrary user ID in the root group, as OpenShift does |
| MikroORM migrations                                            | The first migration applies on SQLite and PostgreSQL, and service tests pass on both   |
| Docker Compose with separate services and PostgreSQL           | e2e tests pass                                                                         |
| Import rules                                                   | Cross-member relative imports and service-to-service imports fail `tests/architecture` |
| Naming rule                                                    | Single-letter names fail `deno lint` through the plugin in `tests/architecture`        |
| TypeScript and Python examples                                 | Both send a two-step conversation that appears under one Session ID                    |
| Web UI in headless Chromium (added 2026-11-07)                 | Main flows work and nothing scrolls sideways from 360px to 2,000px, in all deployments |
| `better-sqlite3` in CI on GitHub (2026-11-07)                  | Works on Linux x64 on the `ubuntu-24.04` runner, including the all-in-one image        |

The Logs step added these checks on 2026-11-09.

| Tested                                                             | Result                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OTel JS log exporters over HTTP/protobuf, HTTP/JSON, gzip and gRPC | Log Records found by a word through the Gateway with their trace, span and Correlation ID, in all-in-one and in separate services            |
| Telemetry logs on SQLite and PostgreSQL                            | Search, time range, severity, attribute filters, paging, repeated batches and rejection work on both                                         |
| Eight replicas creating one day's partition                        | All succeed, three rounds in a row. Without the advisory lock the losers fail with `relation already exists`                                 |
| A time range on PostgreSQL                                         | The query plan reads only the partition of the range                                                                                         |
| Text a database would refuse                                       | U+0000, a lone surrogate and a 240,000-character body are stored, and search input is never read as query syntax                             |
| Logs page and a trace's logs in headless Chromium                  | Searching, filtering, a record's details, going to its span, paging and rejected counts work; nothing scrolls sideways from 360px to 2,040px |

The Trace completion and Telemetry Evaluator step added these checks on 2026-11-09.

| Tested                                               | Result                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Telemetry Evaluator on real spans                    | OTLP spans through the Gateway pass and fail as expected, in all-in-one and in separate services                                           |
| Missing root span                                    | Three attempts end as Error and the run's verdict is `error`, with shortened timers                                                        |
| Reused Correlation ID                                | Telemetry from before the attempt and an ID used by the previous attempt both end as Error; a retry with a new ID passes                   |
| A span that arrives after evaluation                 | Stored and flagged by `GET /v1/traces/{traceId}`, and the verdict does not change                                                          |
| Trace completion and mixed telemetry, on both stores | The root-span rule, timeouts, a Telemetry outage and every mixed-telemetry rule on SQLite and PostgreSQL, against a stand-in for Telemetry |
| Delayed jobs                                         | pg-boss and the SQLite queue hold a job back for its delay                                                                                 |
| Internal endpoints                                   | Refuse a user's token, even as `admin`, and API keys; the Gateway does not forward them                                                    |
| Telemetry Evaluator editor and results in Chromium   | Creating one, an invalid attribute, matched spans, the link to the span in its trace, and nothing scrolls sideways from 360px to 2,000px   |

The Datasets and Client-Driven Execution step added these checks on 2026-11-08.

| Tested                                                    | Result                                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Evaluation service on SQLite and PostgreSQL               | Datasets, runs, retries, repeated reports, copies of Test Cases, early finish and inactive runs work on both            |
| Concurrent evaluations of one run                         | Two deliveries each of eight jobs at once finish the run once with eight attempts, on both databases                    |
| pg-boss 12.38.1 on PostgreSQL 17 in a container           | Delivers jobs and retries a failing one exactly up to its limit, from the Evaluation service's API and worker processes |
| A slow regular expression                                 | `^(a+)+$` on 40 characters is terminated in its Web Worker at the time limit and ends as Error                          |
| Five replicas starting at once on an empty server         | They create one database and apply its migrations once. API and worker starting together first exposed this race        |
| The example scripts in TypeScript and Python              | Both run a Dataset to the verdict `passed` through the Gateway, in all-in-one and in separate services                  |
| Datasets, Test Cases and run results in headless Chromium | Creating, editing, an invalid pattern and a run's results work, and nothing scrolls sideways from 360px to 2,000px      |

The OIDC sign-in step added these checks on 2026-11-09.

| Tested                                                | Result                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC against Keycloak 26.4.7 in headless Chromium     | Authorization code flow with PKCE across sites, a new user with the Role of the mapped Group, in all-in-one on SQLite and services on PostgreSQL   |
| OIDC against a fake provider on SQLite and PostgreSQL | Replayed `state`, another browser, a wrong nonce, a rejected code, an unverified or taken email and an unreachable provider all refuse the sign-in |
| Company groups                                        | A sign-in adds and removes memberships from Company groups, and leaves members added by hand                                                       |
| Guessing passwords                                    | The limits per account and per address hold on both databases and through the Gateway, and end with the window                                     |
| Changing one's own password in Chromium               | The wrong current password is refused, and the change ends the user's other sign-ins                                                               |

The Users, Groups, Roles and tokens step added these checks on 2026-11-08.

| Tested                                           | Result                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity service on SQLite and PostgreSQL        | Sign-in, sign-out, users, Groups, Role assignments, the first administrator, service tokens and the last-admin rule work on both                           |
| Roles through the Gateway                        | A `viewer` reads prompts and traces but gets `403` for changes and for OTLP; an `editor` changes prompts; a Project `admin` manages Roles, an `editor` not |
| Service token for one Project                    | Reads the Project's prompts through the Gateway and gets `403` for changes, in separate services; Identity refuses a user's token on its internal API      |
| Access tokens verified locally                   | Services verify tokens with the JWKS endpoint's keys, read again for a new key ID; expired, foreign and malformed tokens are refused                       |
| Sign-in, Project switcher and Access in Chromium | Signing in and out, assigning a Role, switching Projects, creating users and Groups, and a viewer without change buttons work                              |

The Projects and API keys step added these checks on 2026-11-07.

| Tested                                    | Result                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity service on SQLite and PostgreSQL | Projects, API keys, revocation, deletion and the first-start Project work on both; five replicas starting at once create one first Project                          |
| A key created through the Gateway         | Accepted by OTLP/HTTP, OTLP/gRPC and the Telemetry and Prompt REST APIs at once, in all-in-one, in separate services, in the all-in-one image and in Docker Compose |
| Revoking a key and deleting a Project     | Both keys were refused by every entry point about 60.5 seconds later, after the cached answers expired                                                              |
| Identity unavailable                      | Telemetry and Prompt answer `503` with `Retry-After`, and gRPC `UNAVAILABLE`, instead of refusing the key                                                           |
| First start of the all-in-one process     | Generates and logs the Instance admin key and the `Default` Project's key once; a restart reuses the stored admin key and logs neither                              |
| Projects pages in headless Chromium       | Entering the admin key, creating a Project and a key, using it in the browser, revoking and deleting work; nothing scrolls sideways from 360px to 2,000px           |

The Prompt service step added these checks on 2026-11-07.

| Tested                                          | Result                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Prompt service on SQLite and PostgreSQL         | Creating, versioning, labelling and comparing work on both, and five concurrent additions get five distinct numbers      |
| A database per service on one PostgreSQL server | Each service creates its own database on first start, in tests, e2e and Docker Compose                                   |
| Combined OpenAPI document                       | The Gateway serves Telemetry and Prompt paths in one OpenAPI 3.1 document built from the contracts, without calling them |
| Prompt flows through the Gateway                | REST and browser e2e tests pass in all-in-one, in separate services and against Docker Compose                           |
| React Router 8 in declarative mode              | Keyboard selection on the Traces page needs `useTransitions={false}`, otherwise the URL state lags one key press         |

### What has not been verified

- The capacity target of 5,000 spans per second
- The Prompt and Identity images running against a managed PostgreSQL service, where the user may
  not be allowed to create databases; they then need their databases created beforehand
- That Identity's port stays unreachable from outside the Instance in Kubernetes
- Service tokens across the network in the all-in-one deployment: its services call Identity in the
  process, and no other client reaches Identity's internal API there. The all-in-one e2e tests cover
  them only indirectly, because API key resolution needs one
- Signing key rotation, which is not built, and many replicas creating the first signing key at once
- OIDC with Microsoft Entra ID, Okta or any provider other than Keycloak. Entra replaces the groups
  claim with a link to Microsoft Graph for a user in more than 200 groups, which Extispex does not
  follow, and such a user gets no Company groups
- OIDC in the all-in-one image and Docker Compose, where the Instance must reach the provider at the
  address the browser uses; the e2e tests run OIDC only in the all-in-one process and separate
  services
- That guessing protection cannot be used to lock someone out: anyone who can reach the sign-in
  endpoint can keep a known email blocked for local accounts. Users signing in through OIDC are not
  affected
- `GATEWAY_TRUSTED_PROXY_COUNT` behind a real load balancer
- Browsers other than Chromium with the sign-in cookie
- pg-boss under sustained load and on a managed PostgreSQL service
- Mixed-telemetry protection with clock differences between Evaluation and Telemetry: it compares
  the start of an attempt on Evaluation's clock with receive times on Telemetry's. Servers are
  assumed to be synchronized, so a difference larger than the time a script needs to start could
  reject an attempt
- The default timers of 10 and 60 seconds end to end; the e2e tests shorten them
- The evaluation worker's new environment in Docker Compose: its configuration was only validated,
  not started
- The 10,000-span limit for one Correlation ID: a read that large has not been measured
- Very large Outputs in a result page: 50 Iterations with three attempts of 1 MB each can still
  reach 150 MB in one response
- Log ingestion and search at the capacity target, and how attribute filters behave on a large
  Project: they have no index, so they read every record that the other filters leave
- The exclusive lock of creating a partition under load
- Sending logs from Python: only the TypeScript helper has a log record processor
- The rule that modules inside a service import each other only through their public entry points;
  no automated check enforces it yet
- The web UI's colours, spacing and typography, and browsers other than Chromium

### First implementation step

Done on 2026-11-06: one thin path through the whole system in both deployments. An OTLP span goes
through ingestion and storage, can be read through the API and appears in the UI. Until the Identity
service existed, Telemetry and Prompt resolved API keys from a `STATIC_API_KEYS` environment
variable; since step 2 they ask Identity.

The remaining steps and their order are in [roadmap.md](roadmap.md).

## 12. Decision records

- [ADR 0001: pg-boss for the Evaluation job queue](adr/0001-pg-boss-for-evaluation-job-queue.md)
- [ADR 0002: PostgreSQL and SQLite instead of MongoDB](adr/0002-postgresql-and-sqlite-instead-of-mongodb.md)
- [ADR 0003: Independent services without a broker](adr/0003-independent-services-without-a-broker.md)
- [ADR 0004: AGPLv3 for the platform, Apache 2.0 for instrumentation code](adr/0004-agpl-for-the-platform-apache-for-instrumentation.md)
- [ADR 0005: Playwright browser tests with layout rules](adr/0005-playwright-browser-tests-with-layout-rules.md)
- [ADR 0006: Public API routes in the shared contracts](adr/0006-public-api-routes-in-shared-contracts.md)
- [ADR 0007: Prefixed API keys resolved through Identity](adr/0007-prefixed-api-keys-resolved-through-identity.md)
- [ADR 0008: Project-scoped access tokens signed by Identity](adr/0008-project-scoped-access-tokens-signed-by-identity.md)
- [ADR 0009: Client-Driven Execution as a pull protocol](adr/0009-client-driven-execution-as-a-pull-protocol.md)
- [ADR 0010: Telemetry Evaluator conditions as JSON](adr/0010-telemetry-evaluator-conditions-as-json.md)
- [ADR 0011: OIDC users identified by issuer and subject](adr/0011-oidc-users-identified-by-issuer-and-subject.md)
- [ADR 0012: Daily log partitions on the record's own time](adr/0012-daily-log-partitions-on-the-record-time.md)
