import {
  createErrorResponse,
  listMetricAttributesRoute,
  listMetricsRoute,
  queryMetricRoute,
} from "@extispex/contracts";
import {
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
  requireProjectAccess,
} from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { type MetricQueries, MetricQueryError } from "./metric-query.ts";

export interface MetricQueryRouteDependencies {
  metricQueries: MetricQueries;
  requestAuthenticator: RequestAuthenticator;
}

export function registerMetricQueryRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  dependencies: MetricQueryRouteDependencies,
): void {
  // Only the queries: OTLP ingestion shares the path /v1/metrics but answers in OTLP's own format.
  app.on(
    "GET",
    ["/v1/metrics", "/v1/metrics/attributes", "/v1/metrics/query"],
    requireProjectAccess(dependencies.requestAuthenticator),
  );

  app.openapi(listMetricsRoute, async (context) => {
    const metrics = await dependencies.metricQueries.listMetrics(
      context.get("projectAccess").projectId,
    );
    return context.json({ metrics }, 200);
  });

  app.openapi(listMetricAttributesRoute, async (context) => {
    const attributes = await dependencies.metricQueries.listMetricAttributes(
      context.get("projectAccess").projectId,
      context.req.valid("query").metric,
    );
    return context.json(attributes, 200);
  });

  app.openapi(queryMetricRoute, async (context) => {
    try {
      const result = await dependencies.metricQueries.queryMetric(
        context.get("projectAccess").projectId,
        context.req.valid("query"),
      );
      return context.json(result, 200);
    } catch (error) {
      if (error instanceof MetricQueryError) {
        return context.json(createErrorResponse(error.errorCode, error.message), 400);
      }
      throw error;
    }
  });
}
