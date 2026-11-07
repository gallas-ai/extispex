import type { ServiceRequestHandler } from "@extispex/service-client";
import {
  createServiceHttpApp,
  type ProjectResolver,
  type StructuredLogger,
} from "@extispex/service-runtime";
import type * as grpc from "@grpc/grpc-js";
import { createOtlpGrpcServer } from "./ingestion/otlp-grpc-server.ts";
import { registerOtlpHttpRoutes } from "./ingestion/otlp-http-routes.ts";
import { createTraceIngestion } from "./ingestion/trace-ingestion.ts";
import { createSpanRepository } from "./storage/span-repository.ts";
import type { TelemetryDatabase } from "./storage/telemetry-database.ts";
import { registerTraceQueryRoutes } from "./traces/trace-query-routes.ts";

export {
  bindOtlpGrpcServer,
  type GrpcTlsFiles,
  shutdownOtlpGrpcServer,
} from "./ingestion/otlp-grpc-server.ts";
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

  const app = createServiceHttpApp({
    apiTitle: "Extispex: Telemetry API",
    logger: dependencies.logger,
  });
  registerOtlpHttpRoutes(app, {
    traceIngestion,
    projectResolver: dependencies.projectResolver,
    logger: dependencies.logger,
  });
  registerTraceQueryRoutes(app, { spanRepository, projectResolver: dependencies.projectResolver });

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
