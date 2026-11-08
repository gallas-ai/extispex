import type { ServiceRequestHandler } from "@extispex/service-client";
import {
  createServiceHttpApp,
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
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
  requestAuthenticator: RequestAuthenticator;
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

  const app = createServiceHttpApp<ProjectAccessEnvironment>({
    apiTitle: "Extispex: Telemetry API",
    logger: dependencies.logger,
  });
  registerOtlpHttpRoutes(app, {
    traceIngestion,
    requestAuthenticator: dependencies.requestAuthenticator,
    logger: dependencies.logger,
  });
  registerTraceQueryRoutes(app, {
    spanRepository,
    requestAuthenticator: dependencies.requestAuthenticator,
  });

  return {
    handleRequest: (request) => app.fetch(request),
    createGrpcServer: () =>
      createOtlpGrpcServer({
        traceIngestion,
        requestAuthenticator: dependencies.requestAuthenticator,
        logger: dependencies.logger,
      }),
  };
}
