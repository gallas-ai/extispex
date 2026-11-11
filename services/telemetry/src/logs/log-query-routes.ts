import { getRejectedTelemetryRoute, listLogsRoute } from "@extispex/contracts";
import {
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
  requireProjectAccess,
} from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { LogRepository, RejectionRepository } from "../storage/mod.ts";

export interface LogQueryRouteDependencies {
  logRepository: LogRepository;
  rejectionRepository: RejectionRepository;
  requestAuthenticator: RequestAuthenticator;
  readCurrentTime: () => Date;
}

/** How far back the rejected counts reach. A short window shows whether a problem is current. */
const REJECTED_TELEMETRY_WINDOW_HOURS = 24;

export function registerLogQueryRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  dependencies: LogQueryRouteDependencies,
): void {
  // Only the queries: OTLP ingestion shares the path /v1/logs but answers in OTLP's own format.
  app.on(
    "GET",
    ["/v1/logs", "/v1/rejected-telemetry"],
    requireProjectAccess(dependencies.requestAuthenticator),
  );

  app.openapi(listLogsRoute, async (context) => {
    const logPage = await dependencies.logRepository.listLogs(
      context.get("projectAccess").projectId,
      context.req.valid("query"),
    );
    return context.json(logPage, 200);
  });

  app.openapi(getRejectedTelemetryRoute, async (context) => {
    const rejectedTelemetry = await dependencies.rejectionRepository.readRejectedTelemetry(
      context.get("projectAccess").projectId,
      REJECTED_TELEMETRY_WINDOW_HOURS,
      dependencies.readCurrentTime(),
    );
    return context.json(rejectedTelemetry, 200);
  });
}
