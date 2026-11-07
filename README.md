# Extispex

**Read your LLM calls from the inside.**

Self-hosted observability and evaluation for GenAI applications and agents. Your application sends
OpenTelemetry traces; Extispex stores them, lets you find them by your own Correlation ID or Session
ID, and shows them in a web UI. It also keeps your prompts as immutable versions with movable labels
such as `production`, and keeps each Project's data apart behind its own API keys.

> **Why "Extispex"?** An _extispex_ was a Roman diviner, from Latin _exta_ (entrails) and _specio_
> (I look): the one who looks inside. By examining the inner organs of a sacrifice, an extispex
> judged whether an undertaking would end well. Looking inside and judging the outcome is tracing
> and evaluation in one word. The ending _-spex_ also echoes _specs_ and _inspect_.

**Status:** early development. The trace pipeline, versioned prompts, and Projects with API keys
work end to end. Logs, metrics, evaluations, users and sign-in are designed in
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

On first start the instance creates the Project `Default` and logs two keys, once:

```text
{"level":"info","service":"all-in-one","message":"Generated the Instance admin key. …","instanceAdminKey":"extispex_admin_…"}
{"level":"info","service":"all-in-one","message":"Created the first Project. …","projectName":"Default","apiKey":"extispex_…"}
```

Open <http://localhost:8080> and enter the `apiKey`. Then send a sample conversation from
[examples/](examples/) with it. The `instanceAdminKey` manages Projects and API keys under
**Projects**; the image also keeps it in `/data/instance-admin-key`.

To choose the keys yourself, set `INSTANCE_ADMIN_KEY` and `BOOTSTRAP_PROJECT_API_KEY` (at least 32
characters each) before the first start.

## Projects and API keys

A Project keeps its telemetry and prompts apart from every other Project. An application sends one
of the Project's API keys, and the key alone decides where the data goes. Create Projects and keys
under **Projects** in the UI, or through the REST API with the Instance admin key:

```sh
curl -X POST localhost:8080/v1/projects -H "authorization: Bearer $INSTANCE_ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"name": "checkout-assistant"}'
curl -X POST localhost:8080/v1/projects/<project id>/api-keys \
  -H "authorization: Bearer $INSTANCE_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name": "CI pipeline"}'
```

A key looks like `extispex_` followed by 43 letters and digits, and is shown only when it is
created: Extispex stores only its hash. A revoked key, or any key of a deleted Project, stops
working within a minute. The Instance admin key manages Projects but cannot read their data. It
stands in for users and Roles, which come later.

## Sending telemetry

Every span must carry a **Correlation ID** in the `correlation.id` attribute, or it is rejected.
Your application chooses the value, so you can always find a call again by your own identifier.
Spans may also carry `session.id` to group several traces into one conversation. Send the Project's
API key as `Authorization: Bearer <key>`.

The [`telemetry-ids` package](packages/telemetry-ids/) and the
[Python example](examples/python/send_conversation.py) show a span processor that adds both
attributes to every span.

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

## Container images

Images are published to the GitHub Container Registry as `ghcr.io/gallas-ai/extispex-<service>`. The
all-in-one image takes the bare name because it is the one to try first.

| Image                                          | Runs                                       | Status  |
| ---------------------------------------------- | ------------------------------------------ | ------- |
| `ghcr.io/gallas-ai/extispex`                   | Every service in one process, with SQLite  | Built   |
| `ghcr.io/gallas-ai/extispex-gateway`           | Gateway and web UI                         | Built   |
| `ghcr.io/gallas-ai/extispex-telemetry`         | Telemetry service: OTLP ingestion, queries | Built   |
| `ghcr.io/gallas-ai/extispex-evaluation`        | Evaluation service API                     | Planned |
| `ghcr.io/gallas-ai/extispex-evaluation-worker` | Evaluation worker                          | Planned |
| `ghcr.io/gallas-ai/extispex-prompt`            | Prompt service                             | Built   |
| `ghcr.io/gallas-ai/extispex-identity`          | Identity service: Projects and API keys    | Built   |

## Development

You need [Deno](https://deno.com/) 2.9 or later. Docker is needed only for the container images.

Run Extispex from source:

```sh
deno install                # install dependencies
deno task build:web         # build the UI into apps/web/dist, which port 8080 serves
deno task start:all-in-one  # run everything locally on ports 4317, 4318 and 8080, with SQLite in apps/all-in-one/data
```

Open <http://localhost:8080> and enter the API key that the first start logged. In a second
terminal, send a sample conversation with it and search for the Session ID it prints:

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
