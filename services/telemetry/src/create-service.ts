import type { ServiceRequestHandler } from "@extispex/service-client";
import { createBackgroundLease } from "@extispex/service-storage";
import {
  createServiceHttpApp,
  DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS,
  type ProjectAccessEnvironment,
  type ProjectLifecycleSource,
  type RequestAuthenticator,
  type StructuredLogger,
} from "@extispex/service-runtime";
import type * as grpc from "@grpc/grpc-js";
import { createLogIngestion } from "./ingestion/log-ingestion.ts";
import { createMetricIngestion } from "./ingestion/metric-ingestion.ts";
import { createOtlpGrpcServer } from "./ingestion/otlp-grpc-server.ts";
import { registerOtlpHttpRoutes } from "./ingestion/otlp-http-routes.ts";
import { createRejectionRecorder } from "./ingestion/rejection-recorder.ts";
import { createTraceIngestion } from "./ingestion/trace-ingestion.ts";
import { registerLogQueryRoutes } from "./logs/log-query-routes.ts";
import { createMetricQueries } from "./metrics/metric-query.ts";
import { registerMetricQueryRoutes } from "./metrics/metric-query-routes.ts";
import { createLogRepository } from "./storage/log-repository.ts";
import { createMetricRepository } from "./storage/metric-repository.ts";
import { createRejectionRepository } from "./storage/rejection-repository.ts";
import { createRetentionRepository } from "./storage/retention-repository.ts";
import {
  createTelemetryDataLifecycle,
  type TelemetryDataLifecycleOutcome,
} from "./retention/telemetry-data-lifecycle.ts";
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
export type { TelemetryDataLifecycleOutcome } from "./retention/telemetry-data-lifecycle.ts";

export interface TelemetryServiceDependencies {
  database: TelemetryDatabase;
  requestAuthenticator: RequestAuthenticator;
  /** Identity's Retention Periods and deleted Projects, asked with this service's token. */
  projectLifecycle: ProjectLifecycleSource;
  logger: StructuredLogger;
  readCurrentTime?: () => Date;
  /** How often `runDataLifecycle` runs; its lease lasts two intervals. */
  dataLifecycleIntervalMilliseconds?: number;
  /** Who holds the data lifecycle's lease; one ID per process by default. */
  leaseHolder?: string;
}

export interface TelemetryService {
  /** Handles OTLP/HTTP ingestion, trace, log and metric queries, OpenAPI and health checks. */
  handleRequest: ServiceRequestHandler;
  /** Creates an unbound gRPC server for OTLP/gRPC ingestion. */
  createGrpcServer(): grpc.Server;
  /**
   * One run of the periodic data work, if this replica gets the lease: removes deleted Projects'
   * telemetry, expired records and old rejected counts. `main.ts` runs it every
   * `DATA_LIFECYCLE_INTERVAL_MILLISECONDS`.
   */
  runDataLifecycle(): Promise<TelemetryDataLifecycleOutcome>;
}

export function createTelemetryService(
  dependencies: TelemetryServiceDependencies,
): TelemetryService {
  const readCurrentTime = dependencies.readCurrentTime ?? (() => new Date());
  const spanRepository = createSpanRepository(dependencies.database);
  const logRepository = createLogRepository(dependencies.database);
  const metricRepository = createMetricRepository(dependencies.database);
  const rejectionRepository = createRejectionRepository(dependencies.database);
  const rejectionRecorder = createRejectionRecorder(rejectionRepository, dependencies.logger);
  const traceIngestion = createTraceIngestion(spanRepository, rejectionRecorder, readCurrentTime);
  const logIngestion = createLogIngestion(logRepository, rejectionRecorder, readCurrentTime);
  const metricIngestion = createMetricIngestion(
    metricRepository,
    rejectionRecorder,
    readCurrentTime,
  );

  const app = createServiceHttpApp<ProjectAccessEnvironment>({
    apiTitle: "Extispex: Telemetry API",
    logger: dependencies.logger,
  });
  registerOtlpHttpRoutes(app, {
    traceIngestion,
    logIngestion,
    metricIngestion,
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

  registerMetricQueryRoutes(app, {
    metricQueries: createMetricQueries(metricRepository, readCurrentTime),
    requestAuthenticator: dependencies.requestAuthenticator,
  });

  const runDataLifecycle = createTelemetryDataLifecycle({
    retentionRepository: createRetentionRepository(dependencies.database),
    projectLifecycle: dependencies.projectLifecycle,
    lease: createBackgroundLease(dependencies.database, {
      name: "data-lifecycle",
      holder: dependencies.leaseHolder ?? crypto.randomUUID(),
      durationMilliseconds: 2 *
        (dependencies.dataLifecycleIntervalMilliseconds ??
          DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS),
    }),
    isPostgres: dependencies.database.dialect === "postgresql",
    logger: dependencies.logger,
    readCurrentTime,
  });

  return {
    runDataLifecycle,
    handleRequest: (request) => app.fetch(request),
    createGrpcServer: () =>
      createOtlpGrpcServer({
        traceIngestion,
        logIngestion,
        metricIngestion,
        requestAuthenticator: dependencies.requestAuthenticator,
        logger: dependencies.logger,
      }),
  };
}
