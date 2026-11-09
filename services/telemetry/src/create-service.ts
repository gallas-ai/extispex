import type { ServiceRequestHandler } from "@extispex/service-client";
import {
  createServiceHttpApp,
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
  type StructuredLogger,
} from "@extispex/service-runtime";
import type * as grpc from "@grpc/grpc-js";
import { createLogIngestion } from "./ingestion/log-ingestion.ts";
import { createOtlpGrpcServer } from "./ingestion/otlp-grpc-server.ts";
import { registerOtlpHttpRoutes } from "./ingestion/otlp-http-routes.ts";
import { createRejectionRecorder } from "./ingestion/rejection-recorder.ts";
import { createTraceIngestion } from "./ingestion/trace-ingestion.ts";
import { registerLogQueryRoutes } from "./logs/log-query-routes.ts";
import { createLogRepository } from "./storage/log-repository.ts";
import { createRejectionRepository } from "./storage/rejection-repository.ts";
import { createSpanRepository } from "./storage/span-repository.ts";
import type { TelemetryDatabase } from "./storage/telemetry-database.ts";
import { registerIterationTelemetryRoutes } from "./traces/iteration-telemetry-routes.ts";
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
  /** Handles OTLP/HTTP ingestion, trace and log queries, the OpenAPI document and health checks. */
  handleRequest: ServiceRequestHandler;
  /** Creates an unbound gRPC server for OTLP/gRPC ingestion. */
  createGrpcServer(): grpc.Server;
}

export function createTelemetryService(
  dependencies: TelemetryServiceDependencies,
): TelemetryService {
  const readCurrentTime = dependencies.readCurrentTime ?? (() => new Date());
  const spanRepository = createSpanRepository(dependencies.database);
  const logRepository = createLogRepository(dependencies.database);
  const rejectionRepository = createRejectionRepository(dependencies.database);
  const rejectionRecorder = createRejectionRecorder(rejectionRepository, dependencies.logger);
  const traceIngestion = createTraceIngestion(spanRepository, rejectionRecorder, readCurrentTime);
  const logIngestion = createLogIngestion(logRepository, rejectionRecorder, readCurrentTime);

  const app = createServiceHttpApp<ProjectAccessEnvironment>({
    apiTitle: "Extispex: Telemetry API",
    logger: dependencies.logger,
  });
  registerOtlpHttpRoutes(app, {
    traceIngestion,
    logIngestion,
    requestAuthenticator: dependencies.requestAuthenticator,
    logger: dependencies.logger,
  });
  registerTraceQueryRoutes(app, {
    spanRepository,
    requestAuthenticator: dependencies.requestAuthenticator,
  });
  registerIterationTelemetryRoutes(app, {
    spanRepository,
    requestAuthenticator: dependencies.requestAuthenticator,
    readCurrentTime,
  });
  registerLogQueryRoutes(app, {
    logRepository,
    rejectionRepository,
    requestAuthenticator: dependencies.requestAuthenticator,
    readCurrentTime,
  });

  return {
    handleRequest: (request) => app.fetch(request),
    createGrpcServer: () =>
      createOtlpGrpcServer({
        traceIngestion,
        logIngestion,
        requestAuthenticator: dependencies.requestAuthenticator,
        logger: dependencies.logger,
      }),
  };
}
