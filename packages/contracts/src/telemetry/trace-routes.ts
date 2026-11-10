import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  commonErrorResponses,
  describeErrorResponse,
  projectDataSecurity,
} from "../openapi-route-parts.ts";
import { telemetryLogRoutes } from "./log-routes.ts";
import { telemetryMetricRoutes } from "./metric-routes.ts";
import {
  listTracesQuerySchema,
  listTracesResponseSchema,
  traceDetailResponseSchema,
} from "./trace-contracts.ts";

export const listTracesRoute = createRoute({
  method: "get",
  path: "/v1/traces",
  summary: "List traces, newest first, optionally filtered by Correlation ID or Session ID.",
  tags: ["Traces"],
  security: projectDataSecurity,
  request: { query: listTracesQuerySchema },
  responses: {
    200: {
      description: "Matching traces.",
      content: { "application/json": { schema: listTracesResponseSchema } },
    },
    ...commonErrorResponses,
  },
});

export const getTraceRoute = createRoute({
  method: "get",
  path: "/v1/traces/{traceId}",
  summary: "Get all stored spans of one trace.",
  tags: ["Traces"],
  security: projectDataSecurity,
  request: {
    params: z.object({ traceId: z.string().regex(/^[0-9a-f]{32}$/) }),
  },
  responses: {
    200: {
      description: "The trace and its spans.",
      content: { "application/json": { schema: traceDetailResponseSchema } },
    },
    ...commonErrorResponses,
    404: describeErrorResponse("No spans are stored for this trace."),
  },
});

/** The Telemetry endpoints reachable through the Gateway. OTLP ingestion bypasses it. */
export const telemetryPublicRoutes = [
  listTracesRoute,
  getTraceRoute,
  ...telemetryLogRoutes,
  ...telemetryMetricRoutes,
];
