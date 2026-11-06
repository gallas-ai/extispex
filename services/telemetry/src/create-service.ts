import { createErrorResponse } from "@evaluation-telemetry/contracts";
import type { ServiceRequestHandler } from "@evaluation-telemetry/service-client";
import type { StructuredLogger } from "@evaluation-telemetry/service-runtime";
import type * as grpc from "@grpc/grpc-js";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createOtlpGrpcServer } from "./ingestion/otlp-grpc-server.ts";
import { registerOtlpHttpRoutes } from "./ingestion/otlp-http-routes.ts";
import { createTraceIngestion } from "./ingestion/trace-ingestion.ts";
import type { ProjectResolver } from "./projects/project-authentication.ts";
import { createSpanRepository } from "./storage/span-repository.ts";
import type { TelemetryDatabase } from "./storage/telemetry-database.ts";
import { registerTraceQueryRoutes } from "./traces/trace-query-routes.ts";

export {
  bindOtlpGrpcServer,
  type GrpcTlsFiles,
  shutdownOtlpGrpcServer,
} from "./ingestion/otlp-grpc-server.ts";
export {
  createStaticApiKeyProjectResolver,
  type ProjectResolver,
} from "./projects/project-authentication.ts";
export { openTelemetryDatabase, type TelemetryDatabase } from "./storage/telemetry-database.ts";

export interface TelemetryServiceDependencies {
  database: TelemetryDatabase;
  projectResolver: ProjectResolver;
  logger: StructuredLogger;
  readCurrentTime?: () => Date;
}

export interface TelemetryService {
  /** Handles OTLP/HTTP ingestion, trace queries, the OpenAPI document and health checks. */
  handleRequest: ServiceRequestHandler;
  /** Creates an unbound gRPC server for OTLP/gRPC ingestion. */
  createGrpcServer(): grpc.Server;
}

export function createTelemetryService(
  dependencies: TelemetryServiceDependencies,
): TelemetryService {
  const spanRepository = createSpanRepository(dependencies.database);
  const traceIngestion = createTraceIngestion(
    spanRepository,
    dependencies.readCurrentTime ?? (() => new Date()),
  );

  const app = new OpenAPIHono({
    defaultHook: (validationResult, context) => {
      if (!validationResult.success) {
        const issueDescriptions = validationResult.error.issues.map((issue) =>
          `${issue.path.join(".") || "request"}: ${issue.message}`
        );
        return context.json(
          createErrorResponse("invalid_request", issueDescriptions.join("; ")),
          400,
        );
      }
    },
  });
  app.get("/health", (context) => context.json({ status: "ok" }));
  registerOtlpHttpRoutes(app, {
    traceIngestion,
    projectResolver: dependencies.projectResolver,
    logger: dependencies.logger,
  });
  registerTraceQueryRoutes(app, { spanRepository, projectResolver: dependencies.projectResolver });
  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Evaluation Telemetry: Telemetry API", version: "1" },
  });
  app.notFound((context) =>
    context.json(createErrorResponse("not_found", "No such endpoint."), 404)
  );
  app.onError((error, context) => {
    dependencies.logger.error("Unhandled request error", { error, path: context.req.path });
    return context.json(
      createErrorResponse("internal_error", "An unexpected error occurred."),
      500,
    );
  });

  return {
    handleRequest: (request) => app.fetch(request),
    createGrpcServer: () =>
      createOtlpGrpcServer({
        traceIngestion,
        projectResolver: dependencies.projectResolver,
        logger: dependencies.logger,
      }),
  };
}
