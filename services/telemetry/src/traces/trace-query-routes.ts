import {
  createErrorResponse,
  errorResponseSchema,
  listTracesQuerySchema,
  listTracesResponseSchema,
  traceDetailResponseSchema,
} from "@evaluation-telemetry/contracts";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { authenticateProject, type ProjectResolver } from "../projects/project-authentication.ts";
import type { SpanRepository } from "../storage/span-repository.ts";

export interface TraceQueryRouteDependencies {
  spanRepository: SpanRepository;
  projectResolver: ProjectResolver;
}

const bearerSecurity = [{ apiKey: [] }];

const errorResponses = {
  400: {
    description: "The request is invalid.",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  401: {
    description: "The API key is missing or invalid.",
    content: { "application/json": { schema: errorResponseSchema } },
  },
};

const listTracesRoute = createRoute({
  method: "get",
  path: "/v1/traces",
  summary: "List traces, newest first, optionally filtered by Correlation ID or Session ID.",
  security: bearerSecurity,
  request: { query: listTracesQuerySchema },
  responses: {
    200: {
      description: "Matching traces.",
      content: { "application/json": { schema: listTracesResponseSchema } },
    },
    ...errorResponses,
  },
});

const getTraceRoute = createRoute({
  method: "get",
  path: "/v1/traces/{traceId}",
  summary: "Get all stored spans of one trace.",
  security: bearerSecurity,
  request: {
    params: z.object({ traceId: z.string().regex(/^[0-9a-f]{32}$/) }),
  },
  responses: {
    200: {
      description: "The trace and its spans.",
      content: { "application/json": { schema: traceDetailResponseSchema } },
    },
    ...errorResponses,
    404: {
      description: "No spans are stored for this trace.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

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
