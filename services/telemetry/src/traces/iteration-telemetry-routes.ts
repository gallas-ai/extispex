import {
  listCorrelationSpansRoute,
  listSessionSpansRoute,
  markCorrelationEvaluatedRoute,
  MAXIMUM_EVALUATED_SPANS,
  readCorrelationTelemetryRoute,
  readSessionTelemetryRoute,
} from "@extispex/contracts";
import {
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
  requireServiceProjectAccess,
} from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { SpanRepository } from "../storage/mod.ts";

export interface IterationTelemetryRouteDependencies {
  spanRepository: SpanRepository;
  requestAuthenticator: RequestAuthenticator;
  readCurrentTime: () => Date;
}

/** What the Evaluation worker needs to decide when an Iteration's telemetry can be judged. */
export function registerIterationTelemetryRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  dependencies: IterationTelemetryRouteDependencies,
): void {
  const { spanRepository, readCurrentTime } = dependencies;
  app.use("/internal/*", requireServiceProjectAccess(dependencies.requestAuthenticator));

  app.openapi(readCorrelationTelemetryRoute, async (context) => {
    const readAt = readCurrentTime();
    const { firstReceivedAt, traces } = await spanRepository.readCorrelationTelemetry(
      context.get("projectAccess").projectId,
      context.req.valid("param").correlationId,
    );
    return context.json({
      readAt: readAt.toISOString(),
      firstReceivedAt: firstReceivedAt?.toISOString() ?? null,
      traces: traces.map(({ traceId, rootSpanStoredAt }) => ({
        traceId,
        rootSpanStoredAt: rootSpanStoredAt?.toISOString() ?? null,
      })),
    }, 200);
  });

  app.openapi(readSessionTelemetryRoute, async (context) => {
    const readAt = readCurrentTime();
    const firstReceivedAt = await spanRepository.readSessionFirstReceivedAt(
      context.get("projectAccess").projectId,
      context.req.valid("param").sessionId,
    );
    return context.json({
      readAt: readAt.toISOString(),
      firstReceivedAt: firstReceivedAt?.toISOString() ?? null,
    }, 200);
  });

  app.openapi(listCorrelationSpansRoute, async (context) => {
    // Taken before reading, so that a span the read may have missed always counts as late.
    const readAt = readCurrentTime();
    const spans = await spanRepository.listCorrelationSpans(
      context.get("projectAccess").projectId,
      context.req.valid("param").correlationId,
      MAXIMUM_EVALUATED_SPANS + 1,
    );
    return context.json({
      readAt: readAt.toISOString(),
      spans: spans.slice(0, MAXIMUM_EVALUATED_SPANS),
      isTruncated: spans.length > MAXIMUM_EVALUATED_SPANS,
    }, 200);
  });

  app.openapi(listSessionSpansRoute, async (context) => {
    // Taken before reading, so that a span the read may have missed always counts as late.
    const readAt = readCurrentTime();
    const spans = await spanRepository.listSessionSpans(
      context.get("projectAccess").projectId,
      context.req.valid("param").sessionId,
      MAXIMUM_EVALUATED_SPANS + 1,
    );
    return context.json({
      readAt: readAt.toISOString(),
      spans: spans.slice(0, MAXIMUM_EVALUATED_SPANS),
      isTruncated: spans.length > MAXIMUM_EVALUATED_SPANS,
    }, 200);
  });

  app.openapi(markCorrelationEvaluatedRoute, async (context) => {
    await spanRepository.markCorrelationEvaluated(
      context.get("projectAccess").projectId,
      context.req.valid("param").correlationId,
      new Date(context.req.valid("json").evaluatedAt),
    );
    return context.body(null, 204);
  });
}
