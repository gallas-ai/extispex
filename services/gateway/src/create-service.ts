import {
  createErrorResponse,
  PUBLIC_API_INFO,
  PUBLIC_API_SECURITY_SCHEMES,
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
  /** Reverse proxies in front of the Gateway, which decide the browser's address; 0 for none. */
  trustedProxyCount?: number;
  logger: StructuredLogger;
}

/** The server gives the handler the connection, whose peer is the browser or the nearest proxy. */
export interface GatewayConnectionInfo {
  remoteAddr: { hostname?: string };
}

export interface GatewayService {
  handleRequest: (request: Request, connectionInfo?: GatewayConnectionInfo) => ReturnType<
    ServiceRequestHandler
  >;
}

interface GatewayEnvironment {
  Bindings: { clientAddress: string | null };
}

/** Forwarded request headers. Everything else stays at the gateway. */
const FORWARDED_HEADER_NAMES = ["authorization", "accept", "content-type"];
/** Identity also gets cookies, for the sign-in cookie; no other service sees them. */
const IDENTITY_FORWARDED_HEADER_NAMES = [...FORWARDED_HEADER_NAMES, "cookie"];

const SERVICE_DISPLAY_NAMES: Record<PublicApiServiceName, string> = {
  telemetry: "Telemetry",
  prompt: "Prompt",
  identity: "Identity",
  evaluation: "Evaluation",
};

export function createGatewayService(dependencies: GatewayServiceDependencies): GatewayService {
  const app = new Hono<GatewayEnvironment>();

  app.get("/health", (context) => context.json({ status: "ok" }));

  // Only the endpoints in the shared contracts are forwarded, so OTLP ingestion and each
  // service's internal paths stay unreachable through the gateway.
  for (const [serviceName, routes] of Object.entries(publicApiRoutesByService)) {
    const forwardToService = createForwarder(serviceName as PublicApiServiceName, dependencies);
    for (const route of routes) {
      app.on(
        route.method.toUpperCase(),
        convertOpenApiPathToHonoPath(route.path),
        (context) => forwardToService(context.req.raw, context.env.clientAddress),
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

  return {
    handleRequest: (request, connectionInfo) =>
      app.fetch(request, {
        clientAddress: readClientAddress(
          request,
          connectionInfo?.remoteAddr.hostname ?? null,
          dependencies.trustedProxyCount ?? 0,
        ),
      }),
  };
}

/**
 * The browser's address. Addresses that a proxy we do not count could have written are ignored,
 * so a client cannot pick its own by sending `X-Forwarded-For`.
 */
export function readClientAddress(
  request: Request,
  peerAddress: string | null,
  trustedProxyCount: number,
): string | null {
  if (trustedProxyCount === 0) return peerAddress;
  const forwardedAddresses = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  return forwardedAddresses.at(-trustedProxyCount) ?? peerAddress;
}

function createForwarder(
  serviceName: PublicApiServiceName,
  dependencies: GatewayServiceDependencies,
): (request: Request, clientAddress: string | null) => Promise<Response> {
  const serviceClient = dependencies.serviceClients[serviceName];
  const serviceDisplayName = SERVICE_DISPLAY_NAMES[serviceName];
  return async (request, clientAddress) => {
    const forwardedRequest = await createForwardedRequest(
      request,
      serviceName === "identity" ? IDENTITY_FORWARDED_HEADER_NAMES : FORWARDED_HEADER_NAMES,
    );
    // Identity limits password guesses per address; no other service needs the address.
    if (serviceName === "identity" && clientAddress !== null) {
      forwardedRequest.headers.set("x-forwarded-for", clientAddress);
    }
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

async function createForwardedRequest(
  request: Request,
  forwardedHeaderNames: string[],
): Promise<Request> {
  const forwardedHeaders = new Headers();
  for (const headerName of forwardedHeaderNames) {
    const headerValue = request.headers.get(headerName);
    if (headerValue !== null) {
      forwardedHeaders.set(headerName, headerValue);
    }
  }
  // Identity marks the sign-in cookie Secure when the browser used HTTPS. A proxy in front of the
  // Gateway that terminates TLS says so in this header already.
  forwardedHeaders.set(
    "x-forwarded-proto",
    request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", ""),
  );
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers: forwardedHeaders,
    body: hasBody ? await request.arrayBuffer() : undefined,
    // An OIDC sign-in redirects the browser, so the Gateway must not follow it itself.
    redirect: "manual",
  });
}

/** One OpenAPI document for the whole public API, built from the shared route definitions. */
function buildPublicApiDocument(): unknown {
  const documentBuilder = new OpenAPIHono();
  for (const [schemeName, securityScheme] of Object.entries(PUBLIC_API_SECURITY_SCHEMES)) {
    documentBuilder.openAPIRegistry.registerComponent(
      "securitySchemes",
      schemeName,
      securityScheme,
    );
  }
  for (const routes of Object.values(publicApiRoutesByService)) {
    for (const route of routes) {
      documentBuilder.openAPIRegistry.registerPath(route);
    }
  }
  return documentBuilder.getOpenAPI31Document({ openapi: "3.1.0", info: PUBLIC_API_INFO });
}
