import { createRoute } from "@hono/zod-openapi";
import { commonErrorResponses, projectDataSecurity } from "../openapi-route-parts.ts";
import { listLogsQuerySchema, listLogsResponseSchema } from "./log-contracts.ts";
import { rejectedTelemetrySchema } from "./rejected-telemetry-contracts.ts";

export const listLogsRoute = createRoute({
  method: "get",
  path: "/v1/logs",
  summary: "Search log records, newest first, by time range, attributes and words in the body.",
  tags: ["Logs"],
  security: projectDataSecurity,
  request: { query: listLogsQuerySchema },
  responses: {
    200: {
      description: "One page of matching log records and the cursor of the next page, if any.",
      content: { "application/json": { schema: listLogsResponseSchema } },
    },
    ...commonErrorResponses,
  },
});

export const getRejectedTelemetryRoute = createRoute({
  method: "get",
  path: "/v1/rejected-telemetry",
  summary: "Count the spans and log records that ingestion rejected in the last 24 hours.",
  tags: ["Logs", "Traces"],
  security: projectDataSecurity,
  responses: {
    200: {
      description: "The rejected records per signal, with the latest reason.",
      content: { "application/json": { schema: rejectedTelemetrySchema } },
    },
    ...commonErrorResponses,
  },
});

/** The Telemetry log endpoints reachable through the Gateway. OTLP ingestion bypasses it. */
export const telemetryLogRoutes = [listLogsRoute, getRejectedTelemetryRoute];
