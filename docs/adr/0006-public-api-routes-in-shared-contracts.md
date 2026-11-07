---
status: accepted
---

# Define the public API's routes in the shared contracts and build the Gateway from them

Every endpoint of the public REST API is defined once, as a `createRoute` object from
`@hono/zod-openapi`, in `packages/contracts`. `publicApiRoutesByService` lists them by the service
that implements them. Each service attaches its handler to the same objects with `app.openapi()`.
The Gateway reads the list at startup: it forwards exactly those methods and paths to the owning
service, and it builds the combined OpenAPI document at `/v1/openapi.json` from them, without
calling any service.

```ts
// packages/contracts: the definition
export const getPromptVersionRoute = createRoute({ method: "get", path: "/v1/prompts/{promptName}/versions/{versionNumber}", ... });

// services/prompt: the handler
app.openapi(getPromptVersionRoute, async (context) => { ... });

// services/gateway: the forwarding table and the document
app.on("GET", "/v1/prompts/:promptName/versions/:versionNumber", forwardToPrompt);
documentBuilder.openAPIRegistry.registerPath(getPromptVersionRoute);
```

The document, the forwarding table and the services' validation therefore cannot drift apart. The
document is complete even when a service is down, and adding an endpoint to the contracts is the
only step needed to expose it through the Gateway. Paths that are not in the contracts, such as OTLP
ingestion, stay unreachable through the Gateway.

## Considered Options

- **The Gateway merges the services' documents at runtime (rejected):** The Gateway fetches each
  service's `/openapi.json` and merges paths and components, as Ocelot with SwaggerForOcelot and
  Spring Cloud Gateway with springdoc do. It always describes the running versions. It was rejected
  because the document is incomplete while a service is down, the Gateway must resolve component
  name collisions, and its forwarding table would still be a second, hand-written list.
- **Generate the document at build time and commit it (rejected for now):** Kubernetes commits its
  OpenAPI document and CI checks that it is current, so every API change shows in review. It was
  rejected for now because the generator would have to import every service, which the import rules
  forbid outside `apps/all-in-one`. A committed snapshot can still be added later as a test that
  renders the document from the contracts and compares it, for example with oasdiff, to catch
  breaking changes within `/v1`.

## Consequences

- `packages/contracts` depends on `@hono/zod-openapi`. The web UI imports only types from it, so the
  library does not reach the browser bundle.
- A service's own `/openapi.json` describes only its routes and stays available for direct calls.
- All services ship as one version set, so the Gateway's copy of the contracts always matches the
  services it forwards to.
- Request bodies are read into memory before forwarding. That is acceptable for the REST API, whose
  largest bodies are prompts. OTLP traffic does not pass through the Gateway.
