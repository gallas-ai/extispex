# Extispex

**Read your LLM calls from the inside.**

Self-hosted observability and evaluation for GenAI applications and agents. Your application sends
OpenTelemetry traces; Extispex stores them, lets you find them by your own Correlation ID or Session
ID, and shows them in a web UI. It also keeps your prompts as immutable versions with movable labels
such as `production`, and keeps each Project's data apart: people see a Project through the Roles of
their Groups, and applications send its API keys.

> **Why "Extispex"?** An _extispex_ was a Roman diviner, from Latin _exta_ (entrails) and _specio_
> (I look): the one who looks inside. By examining the inner organs of a sacrifice, an extispex
> judged whether an undertaking would end well. Looking inside and judging the outcome is tracing
> and evaluation in one word. The ending _-spex_ also echoes _specs_ and _inspect_.

**Status:** early development. The trace, log and metric pipelines, versioned prompts, Projects with
API keys, users with Groups and Roles synced from the company's directory, and Datasets judged by
Regex Evaluators work end to end. The other Evaluators are designed in
[docs/architecture.md](docs/architecture.md) but not built yet.

## Try it locally

The all-in-one image `ghcr.io/gallas-ai/extispex` runs everything in one container and stores data
in SQLite.

```sh
docker build -f deploy/docker/all-in-one.Dockerfile -t ghcr.io/gallas-ai/extispex .
docker run -p 4317:4317 -p 4318:4318 -p 8080:8080 -v extispex-data:/data \
  ghcr.io/gallas-ai/extispex
```

| Port | Purpose                                              |
| ---- | ---------------------------------------------------- |
| 4317 | OTLP over gRPC                                       |
| 4318 | OTLP over HTTP, protobuf or JSON                     |
| 8080 | Web UI and REST API, described at `/v1/openapi.json` |

On first start the instance creates the Project `Default` with an API key, and the first
administrator, and logs both secrets once:

```text
{"level":"info","service":"all-in-one","message":"Created the first Project. …","projectName":"Default","apiKey":"extispex_…"}
{"level":"info","service":"all-in-one","message":"Created the first administrator. …","email":"admin@extispex.local","password":"…"}
```

Open <http://localhost:8080> and sign in as `admin@extispex.local` with the logged password; the
image also keeps it in `/data/initial-admin-password`. Then send a sample conversation from
[examples/](examples/) with the `apiKey`.

To choose them yourself, set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (at least 12
characters) and `BOOTSTRAP_PROJECT_API_KEY` (at least 32 characters) before the first start.

The image also creates `/data/master-key`, which encrypts Target credentials and the key that signs
access tokens. Keep the volume, or set `MASTER_KEY` (`openssl rand -base64 32`) yourself.

## Projects, users and Roles

A Project keeps its telemetry and prompts apart from every other Project. People belong to Groups,
and each Project gives Groups a Role:

| Role     | May                                                  |
| -------- | ---------------------------------------------------- |
| `viewer` | read traces, logs and prompts                        |
| `editor` | also change prompts and send telemetry               |
| `admin`  | also manage the Project's Role assignments, API keys |

An Instance admin creates Projects, users and Groups under **Projects** and **Access**. The first
administrator is one, in the Group `Administrators`, which has the Role `admin` in `Default`. A
Project's `admin` gives Groups Roles and creates API keys on the Project's page.

The browser signs in with an HttpOnly cookie and gets access tokens that last five minutes, so a
removed Role or a deactivated user loses access within five minutes.

People sign in through the company's identity provider, or with local accounts. Local accounts are
always on in the all-in-one image, and in the separate Identity service only with
`LOCAL_ACCOUNTS=enabled`, as a way in when the provider is unavailable. Set these to use OIDC, on
the Identity service or the all-in-one image:

| Variable                   | Meaning                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| `OIDC_ISSUER_URL`          | The provider's issuer. Setting it turns OIDC on.                                |
| `OIDC_CLIENT_ID`           | This Instance's client at the provider.                                         |
| `OIDC_CLIENT_SECRET`       | Its secret.                                                                     |
| `OIDC_REDIRECT_URL`        | `https://<your Instance>/v1/sign-in/oidc/callback`, registered at the provider. |
| `OIDC_SCOPES`              | Optional, default `openid profile email`.                                       |
| `OIDC_GROUPS_CLAIM`        | Optional, default `groups`: the ID token claim that lists Company groups.       |
| `OIDC_PROVIDER_NAME`       | Optional, shown on the sign-in button.                                          |
| `OIDC_ALLOW_INSECURE_HTTP` | `enabled` allows a provider without TLS, for local development only.            |

A user appears on their first sign-in. An Instance admin maps Company groups to Groups under
**Access**, and each sign-in then follows them. Give the first start `LOCAL_ACCOUNTS=enabled` with
`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`, because nobody else can make that mapping
yet; use an address that nobody has at the provider.

To keep people and their Company groups in sync between sign-ins, point the directory's SCIM 2.0
provisioning, such as Microsoft Entra ID's or Okta's, at `https://<your Instance>/scim/v2` with a
directory token that an Instance admin creates under **Access**. A company without SCIM imports a
CSV or JSON file there instead:

```csv
email,displayName,companyGroups,active
grace@acme.example,Grace Hopper,team-engineering|all-staff,true
alan@acme.example,Alan Turing,all-staff,false
```

The directory and files never give Roles: an Instance admin maps Company groups to Groups, and
Projects give Groups their Roles. A user who is deactivated or removed from the directory loses
access within five minutes, and their record stays. Someone the directory knows before their first
OIDC sign-in becomes the same user when they sign in with the same email.

Behind a reverse proxy, set `GATEWAY_TRUSTED_PROXY_COUNT` on the Gateway to the number of proxies,
so that the limit on wrong passwords per address sees browsers and not the proxy.

Applications and scripts send one of the Project's API keys, and the key alone decides the Project.
A key acts as an `editor`. It looks like `extispex_` followed by 43 letters and digits, and is shown
only when it is created: Extispex stores only its hash. A revoked key, or any key of a deleted
Project, stops working within a minute.

## Sending telemetry

Every span must carry a **Correlation ID** in the `correlation.id` attribute, or it is rejected.
Your application chooses the value, so you can always find a call again by your own identifier.
Spans may also carry `session.id` to group several traces into one conversation. Send the Project's
API key as `Authorization: Bearer <key>`.

The [`telemetry-ids` package](packages/telemetry-ids/) and the
[Python example](examples/python/send_conversation.py) show a span processor that adds both
attributes to every span.

Logs go to the same ports, at `/v1/logs` over HTTP. A log with a `trace_id` must carry
`correlation.id` too, and `TelemetryIdsLogRecordProcessor` adds it. A log without a `trace_id`, such
as a startup message, needs nothing extra. A log more than 30 days old or more than one day ahead is
rejected. **Traces** and **Logs** in the UI show how many records were rejected in the last 24
hours, and why.

Metrics go to `/v1/metrics` over HTTP and need neither attribute. Sums, gauges and explicit-bucket
histograms are accepted, cumulative or delta; exponential histograms and summaries are rejected.
**Metrics** in the UI charts one metric with `sum`, `avg`, `rate` or `p95`, grouped by an attribute.

Requests may be compressed with gzip or deflate, over HTTP (`Content-Encoding`) and gRPC alike.
Other encodings, such as zstd or snappy, are refused with `415` on HTTP. One export request may hold
up to 32 MiB after decompression on both protocols, and a larger one is refused with `413` on HTTP
or `RESOURCE_EXHAUSTED` on gRPC. The OpenTelemetry Collector's `otlp` and `otlphttp` exporters
compress with gzip by default, so they work unchanged:

```yaml
exporters:
  otlphttp/extispex:
    endpoint: http://localhost:4318
    compression: gzip # the default; deflate works too
    headers:
      authorization: Bearer ${env:EXTISPEX_API_KEY}
```

## Storing prompts

Create a prompt in the UI under **Prompts**, or through the REST API. Every change is a new,
immutable version, and a Prompt Label such as `production` points to the version your application
uses:

```sh
curl -X POST localhost:8080/v1/prompts -H "authorization: Bearer $EXTISPEX_API_KEY" \
  -H 'content-type: application/json' -d '{
    "name": "support-agent", "type": "chat", "labels": ["production"],
    "messages": [{ "role": "system", "content": "You help customers of {{company}}." }],
    "modelParameters": { "model": "gpt-4.1", "temperature": 0.2 }
  }'
curl localhost:8080/v1/prompts/support-agent/labels/production \
  -H "authorization: Bearer $EXTISPEX_API_KEY"
```

The full API, including comparing two versions, is described at `/v1/openapi.json`.

## Evaluating your application

A Dataset holds Test Cases: an input, or the steps of a whole Session, and the Evaluators that judge
your application's Output and spans. Create Datasets under **Datasets** in the UI or through the
REST API, and see the results under **Runs**. There are two ways to run one:

- **Server-Driven Execution:** create a Target under **Targets**, the URL of your application, and
  choose **Run against Target** on a Dataset. The platform calls the Target for every step. Separate
  services call only the addresses in `EVALUATION_TARGET_ALLOWED_DESTINATIONS`, such as
  `agent.company.example:443,10.20.0.0/16`; the local image allows any.
  [examples/](examples/README.md) has a sample Target.
- **Client-Driven Execution:** your own script runs the application and reports each Output, so this
  works from any CI job. [examples/](examples/README.md) has a complete script in TypeScript and
  Python:

```sh
cd examples/typescript && API_KEY=$EXTISPEX_API_KEY deno task run-dataset
```

The script exits with 0 only when the run's verdict is `passed`.

## Container images

Images are published to the GitHub Container Registry as `ghcr.io/gallas-ai/extispex-<service>`. The
all-in-one image takes the bare name because it is the one to try first.

| Image                                          | Runs                                       | Status |
| ---------------------------------------------- | ------------------------------------------ | ------ |
| `ghcr.io/gallas-ai/extispex`                   | Every service in one process, with SQLite  | Built  |
| `ghcr.io/gallas-ai/extispex-gateway`           | Gateway and web UI                         | Built  |
| `ghcr.io/gallas-ai/extispex-telemetry`         | Telemetry service: OTLP ingestion, queries | Built  |
| `ghcr.io/gallas-ai/extispex-evaluation`        | Evaluation service API                     | Built  |
| `ghcr.io/gallas-ai/extispex-evaluation-worker` | Evaluation worker                          | Built  |
| `ghcr.io/gallas-ai/extispex-prompt`            | Prompt service                             | Built  |
| `ghcr.io/gallas-ai/extispex-identity`          | Identity service: users, Roles, API keys   | Built  |

## Development

You need [Deno](https://deno.com/) 2.9 or later. Docker is needed only for the container images.

Run Extispex from source:

```sh
deno install                # install dependencies
deno task build:web         # build the UI into apps/web/dist, which port 8080 serves
deno task start:all-in-one  # run everything locally on ports 4317, 4318 and 8080, with SQLite in apps/all-in-one/data
```

Open <http://localhost:8080> and sign in with the email and password that the first start logged. In
a second terminal, send a sample conversation with the logged API key and search for the Session ID
it prints:

```sh
cd examples/typescript && API_KEY=extispex_… deno task send-conversation
```

To work on the UI, run `deno task dev:web` next to the running instance and open
<http://localhost:5173>. It reloads on every change and uses the API on port 8080. After changing
the UI, rebuild it with `deno task build:web` before relying on port 8080.

Before you push:

```sh
deno task check             # format, lint and type checks
deno task test              # unit, service and architecture tests
deno task build:web && deno task test:e2e  # end-to-end tests
```

To include PostgreSQL in `deno task test`, set `TEST_POSTGRES_URL` to a server, such as
`postgresql://extispex:extispex@localhost:5432/extispex`; each service's tests create their own
database `<service>_test` there. To run the services separately against PostgreSQL, use
`docker compose -f deploy/compose/compose.yaml up --build`.

## Documentation

- [GLOSSARY.md](GLOSSARY.md): the domain language used in code, API and UI
- [docs/architecture.md](docs/architecture.md): services, data ownership, flows and what has been
  verified
- [docs/adr/](docs/adr/): records of decisions that would otherwise be surprising
- [docs/business.md](docs/business.md): the original requirements, in Czech

## License

Extispex is free software under the [GNU Affero General Public License v3.0](LICENSE). You may run,
study, change and share it, including commercially. If you distribute Extispex, or let others use a
modified version over a network, you must make the complete source of that version available under
the same licence.

The code you add to your own application is under the more permissive
[Apache License 2.0](packages/telemetry-ids/LICENSE), so using it does not affect how you license
your application: the [`telemetry-ids` package](packages/telemetry-ids/) and the
[examples](examples/). See
[ADR 0004](docs/adr/0004-agpl-for-the-platform-apache-for-instrumentation.md) for the reasons.

Copyright © 2026 Milan Gallas.
