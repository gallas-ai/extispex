import { createErrorResponse } from "@extispex/contracts";
import type { ServiceClient, ServiceRequestHandler } from "@extispex/service-client";
import type { StructuredLogger } from "@extispex/service-runtime";
import { Hono } from "hono";
import { serveDir, serveFile } from "@std/http/file-server";

export interface GatewayServiceDependencies {
  telemetryClient: ServiceClient;
  /** Directory with the built web UI, or null to serve the API only. */
  webAssetsDirectory: string | null;
  logger: StructuredLogger;
}

export interface GatewayService {
  handleRequest: ServiceRequestHandler;
}

/** Forwarded request headers. Everything else stays at the gateway. */
const FORWARDED_HEADER_NAMES = ["authorization", "accept", "content-type"];

export function createGatewayService(dependencies: GatewayServiceDependencies): GatewayService {
  const app = new Hono();

  app.get("/health", (context) => context.json({ status: "ok" }));

  const forwardToTelemetry = async (request: Request) => {
    try {
      return await dependencies.telemetryClient(createForwardedRequest(request));
    } catch (error) {
      dependencies.logger.error("Telemetry service is unreachable", { error });
      return Response.json(
        createErrorResponse("service_unavailable", "The Telemetry service is unavailable."),
        { status: 503 },
      );
    }
  };
  app.get("/v1/traces", (context) => forwardToTelemetry(context.req.raw));
  app.get("/v1/traces/:traceId", (context) => forwardToTelemetry(context.req.raw));
  app.get(
    "/v1/openapi.json",
    (context) =>
      forwardToTelemetry(new Request(new URL("/openapi.json", context.req.url), context.req.raw)),
  );
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

function createForwardedRequest(request: Request): Request {
  const forwardedHeaders = new Headers();
  for (const headerName of FORWARDED_HEADER_NAMES) {
    const headerValue = request.headers.get(headerName);
    if (headerValue !== null) {
      forwardedHeaders.set(headerName, headerValue);
    }
  }
  return new Request(request.url, { method: request.method, headers: forwardedHeaders });
}
