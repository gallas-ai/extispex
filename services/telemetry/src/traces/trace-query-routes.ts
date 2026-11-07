import { createErrorResponse, getTraceRoute, listTracesRoute } from "@extispex/contracts";
import { authenticateProject, type ProjectResolver } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { SpanRepository } from "../storage/span-repository.ts";

export interface TraceQueryRouteDependencies {
  spanRepository: SpanRepository;
  projectResolver: ProjectResolver;
}

const unauthenticatedError = createErrorResponse(
  "unauthenticated",
  "A valid API key is required in the Authorization header as a Bearer token.",
);

export function registerTraceQueryRoutes(
  app: OpenAPIHono,
  dependencies: TraceQueryRouteDependencies,
): void {
  app.openapi(listTracesRoute, async (context) => {
    const projectId = await authenticateProject(
      dependencies.projectResolver,
      context.req.header("authorization"),
    );
    if (projectId === null) {
      return context.json(unauthenticatedError, 401);
    }
    const traces = await dependencies.spanRepository.listTraces(
      projectId,
      context.req.valid("query"),
    );
    return context.json({ traces }, 200);
  });

  app.openapi(getTraceRoute, async (context) => {
    const projectId = await authenticateProject(
      dependencies.projectResolver,
      context.req.header("authorization"),
    );
    if (projectId === null) {
      return context.json(unauthenticatedError, 401);
    }
    const { traceId } = context.req.valid("param");
    const spans = await dependencies.spanRepository.findTraceSpans(projectId, traceId);
    if (spans.length === 0) {
      return context.json(createErrorResponse("not_found", `Trace ${traceId} was not found.`), 404);
    }
    return context.json({ traceId, spans }, 200);
  });
}
