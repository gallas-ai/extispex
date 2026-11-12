import { createErrorResponse, getTraceRoute, listTracesRoute } from "@extispex/contracts";
import {
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
  requireProjectAccess,
} from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { SpanRepository } from "../storage/mod.ts";

export interface TraceQueryRouteDependencies {
  spanRepository: SpanRepository;
  requestAuthenticator: RequestAuthenticator;
}

export function registerTraceQueryRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  dependencies: TraceQueryRouteDependencies,
): void {
  // Only the queries: OTLP ingestion shares the path /v1/traces but answers in OTLP's own format.
  app.on(
    "GET",
    ["/v1/traces", "/v1/traces/*"],
    requireProjectAccess(dependencies.requestAuthenticator),
  );

  app.openapi(listTracesRoute, async (context) => {
    const traces = await dependencies.spanRepository.listTraces(
      context.get("projectAccess").projectId,
      context.req.valid("query"),
    );
    return context.json({ traces }, 200);
  });

  app.openapi(getTraceRoute, async (context) => {
    const { traceId } = context.req.valid("param");
    const spans = await dependencies.spanRepository.findTraceSpans(
      context.get("projectAccess").projectId,
      traceId,
    );
    if (spans.length === 0) {
      return context.json(createErrorResponse("not_found", `Trace ${traceId} was not found.`), 404);
    }
    return context.json({ traceId, spans }, 200);
  });
}
