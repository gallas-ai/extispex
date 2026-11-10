import { createRoute } from "@hono/zod-openapi";
import { commonErrorResponses, projectDataSecurity } from "../openapi-route-parts.ts";
import {
  listMetricAttributesQuerySchema,
  listMetricAttributesResponseSchema,
  listMetricsResponseSchema,
  queryMetricQuerySchema,
  queryMetricResponseSchema,
} from "./metric-contracts.ts";

export const listMetricsRoute = createRoute({
  method: "get",
  path: "/v1/metrics",
  summary: "List the Project's metrics with their types and supported aggregations.",
  tags: ["Metrics"],
  security: projectDataSecurity,
  responses: {
    200: {
      description: "The metrics, sorted by name.",
      content: { "application/json": { schema: listMetricsResponseSchema } },
    },
    ...commonErrorResponses,
  },
});

export const listMetricAttributesRoute = createRoute({
  method: "get",
  path: "/v1/metrics/attributes",
  summary: "List the attributes of one metric's Time Series, to filter or group by.",
  tags: ["Metrics"],
  security: projectDataSecurity,
  request: { query: listMetricAttributesQuerySchema },
  responses: {
    200: {
      description: "The attribute keys, each with some of its values.",
      content: { "application/json": { schema: listMetricAttributesResponseSchema } },
    },
    ...commonErrorResponses,
  },
});

export const queryMetricRoute = createRoute({
  method: "get",
  path: "/v1/metrics/query",
  summary: "Aggregate a metric over time with sum, avg, rate or p95, optionally grouped.",
  tags: ["Metrics"],
  security: projectDataSecurity,
  request: { query: queryMetricQuerySchema },
  responses: {
    200: {
      description: "One value per step for each group.",
      content: { "application/json": { schema: queryMetricResponseSchema } },
    },
    ...commonErrorResponses,
  },
});

/** The Telemetry metric endpoints reachable through the Gateway. OTLP ingestion bypasses it. */
export const telemetryMetricRoutes = [
  listMetricsRoute,
  listMetricAttributesRoute,
  queryMetricRoute,
];
