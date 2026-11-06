# Evaluation Telemetry

Self-hosted observability and evaluation for GenAI applications and agents. Your application sends
OpenTelemetry traces; the platform stores them, lets you find them by your own Correlation ID or
Session ID, and shows them in a web UI.

**Status:** early development. The trace pipeline works end to end. Logs, metrics, evaluations,
prompts and identity management are designed in [docs/architecture.md](docs/architecture.md) but not
built yet.

## Try it locally

The `all-in-one` image runs everything in one container and stores data in SQLite.

```sh
docker build -f deploy/docker/all-in-one.Dockerfile -t evaluation-telemetry/all-in-one .
docker run -p 4317:4317 -p 4318:4318 -p 8080:8080 -v evaluation-telemetry-data:/data \
  evaluation-telemetry/all-in-one
```

| Port | Purpose                                              |
| ---- | ---------------------------------------------------- |
| 4317 | OTLP over gRPC                                       |
| 4318 | OTLP over HTTP, protobuf or JSON                     |
| 8080 | Web UI and REST API, described at `/v1/openapi.json` |

Open <http://localhost:8080> and enter the API key `local-development-key`. Set
`STATIC_API_KEYS=your-key=your-project` before exposing the instance to anyone else.

Then send a sample conversation from [examples/](examples/).

## Sending telemetry

Every span must carry a **Correlation ID** in the `correlation.id` attribute, or it is rejected.
Your application chooses the value, so you can always find a call again by your own identifier.
Spans may also carry `session.id` to group several traces into one conversation. Send the API key as
`Authorization: Bearer <key>`.

The [`telemetry-ids` package](packages/telemetry-ids/) and the
[Python example](examples/python/send_conversation.py) show a span processor that adds both
attributes to every span.

## Development

You need [Deno](https://deno.com/) 2.9 or later. Docker is needed only for the container images.

```sh
deno install                # install dependencies
deno task start:all-in-one  # run everything locally on ports 4317, 4318 and 8080
deno task dev:web           # UI with hot reload on port 5173, using the running gateway
deno task check             # format, lint and type checks
deno task test              # unit, service and architecture tests
deno task build:web && deno task test:e2e  # end-to-end tests
```

To include PostgreSQL in `deno task test`, set `TELEMETRY_TEST_POSTGRES_URL`. To run the services
separately against PostgreSQL, use `docker compose -f deploy/compose/compose.yaml up --build`.

## Documentation

- [GLOSSARY.md](GLOSSARY.md): the domain language used in code, API and UI
- [docs/architecture.md](docs/architecture.md): services, data ownership, flows and what has been
  verified
- [docs/adr/](docs/adr/): records of decisions that would otherwise be surprising
- [docs/business.md](docs/business.md): the original requirements, in Czech
