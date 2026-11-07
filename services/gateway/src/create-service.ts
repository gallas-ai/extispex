import {
  API_KEY_SECURITY_SCHEME,
  API_KEY_SECURITY_SCHEME_NAME,
  createErrorResponse,
  PUBLIC_API_INFO,
  publicApiRoutesByService,
  type PublicApiServiceName,
} from "@extispex/contracts";
import type { ServiceClient, ServiceRequestHandler } from "@extispex/service-client";
import type { StructuredLogger } from "@extispex/service-runtime";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { serveDir, serveFile } from "@std/http/file-server";

export interface GatewayServiceDependencies {
  /** One client per service behind the public REST API. */
  serviceClients: Record<PublicApiServiceName, ServiceClient>;
  /** Directory with the built web UI, or null to serve the API only. */
  webAssetsDirectory: string | null;
  logger: StructuredLogger;
}

export interface GatewayService {
  handleRequest: ServiceRequestHandler;
}

/** Forwarded request headers. Everything else stays at the gateway. */
const FORWARDED_HEADER_NAMES = ["authorization", "accept", "content-type"];

const SERVICE_DISPLAY_NAMES: Record<PublicApiServiceName, string> = {
  telemetry: "Telemetry",
  prompt: "Prompt",
};

export function createGatewayService(dependencies: GatewayServiceDependencies): GatewayService {
  const app = new Hono();

  app.get("/health", (context) => context.json({ status: "ok" }));

  // Only the endpoints in the shared contracts are forwarded, so OTLP ingestion and each
  // service's internal paths stay unreachable through the gateway.
  for (const [serviceName, routes] of Object.entries(publicApiRoutesByService)) {
    const forwardToService = createForwarder(serviceName as PublicApiServiceName, dependencies);
    for (const route of routes) {
      app.on(
        route.method.toUpperCase(),
        convertOpenApiPathToHonoPath(route.path),
        (context) => forwardToService(context.req.raw),
      );
    }
  }

  let publicApiDocument: unknown = null;
  app.get("/v1/openapi.json", (context) => {
    publicApiDocument ??= buildPublicApiDocument();
    return context.json(publicApiDocument);
  });
  app.all(
    "/v1/*",
    (context) => context.json(createErrorResponse("not_found", "No such endpoint."), 404),
  );

  if (dependencies.webAssetsDirectory !== null) {
    const webAssetsDirectory = dependencies.webAssetsDirectory;
    app.get("/*", async (context) => {
      const assetResponse = await serveDir(context.req.raw, {
        fsRoot: webAssetsDirectory,
        quiet: true,
      });
      if (assetResponse.status !== 404) {
        return assetResponse;
      }
      await assetResponse.body?.cancel();
      // The UI routes in the browser, so unknown paths get the app shell.
      return await serveFile(context.req.raw, `${webAssetsDirectory}/index.html`);
    });
  }

  return { handleRequest: (request) => app.fetch(request) };
}

function createForwarder(
  serviceName: PublicApiServiceName,
  dependencies: GatewayServiceDependencies,
): (request: Request) => Promise<Response> {
  const serviceClient = dependencies.serviceClients[serviceName];
  const serviceDisplayName = SERVICE_DISPLAY_NAMES[serviceName];
  return async (request) => {
    const forwardedRequest = await createForwardedRequest(request);
    try {
      return await serviceClient(forwardedRequest);
    } catch (error) {
      dependencies.logger.error(`${serviceDisplayName} service is unreachable`, { error });
      return Response.json(
        createErrorResponse(
          "service_unavailable",
          `The ${serviceDisplayName} service is unavailable.`,
        ),
        { status: 503 },
      );
    }
  };
}

/** `/v1/prompts/{promptName}` in OpenAPI is `/v1/prompts/:promptName` in Hono. */
export function convertOpenApiPathToHonoPath(openApiPath: string): string {
  return openApiPath.replaceAll(/\{([^}]+)\}/g, ":$1");
}

async function createForwardedRequest(request: Request): Promise<Request> {
  const forwardedHeaders = new Headers();
  for (const headerName of FORWARDED_HEADER_NAMES) {
    const headerValue = request.headers.get(headerName);
    if (headerValue !== null) {
      forwardedHeaders.set(headerName, headerValue);
    }
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers: forwardedHeaders,
    body: hasBody ? await request.arrayBuffer() : undefined,
  });
}

/** One OpenAPI document for the whole public API, built from the shared route definitions. */
function buildPublicApiDocument(): unknown {
  const documentBuilder = new OpenAPIHono();
  documentBuilder.openAPIRegistry.registerComponent(
    "securitySchemes",
    API_KEY_SECURITY_SCHEME_NAME,
    API_KEY_SECURITY_SCHEME,
  );
  for (const routes of Object.values(publicApiRoutesByService)) {
    for (const route of routes) {
      documentBuilder.openAPIRegistry.registerPath(route);
    }
  }
  return documentBuilder.getOpenAPI31Document({ openapi: "3.1.0", info: PUBLIC_API_INFO });
}
