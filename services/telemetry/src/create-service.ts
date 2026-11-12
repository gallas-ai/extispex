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
import {
  createLogIngestion,
  createMetricIngestion,
  createOtlpGrpcServer,
  createRejectionRecorder,
  createTraceIngestion,
  registerOtlpHttpRoutes,
} from "./ingestion/mod.ts";
import { registerLogQueryRoutes } from "./logs/mod.ts";
import { createMetricQueries, registerMetricQueryRoutes } from "./metrics/mod.ts";
import {
  createLogRepository,
  createMetricRepository,
  createRejectionRepository,
  createRetentionRepository,
  createSpanRepository,
  type TelemetryDatabase,
} from "./storage/mod.ts";
import {
  createTelemetryDataLifecycle,
  type TelemetryDataLifecycleOutcome,
} from "./retention/mod.ts";
import { registerIterationTelemetryRoutes, registerTraceQueryRoutes } from "./traces/mod.ts";

export { bindOtlpGrpcServer, type GrpcTlsFiles, shutdownOtlpGrpcServer } from "./ingestion/mod.ts";
export { openTelemetryDatabase, type TelemetryDatabase } from "./storage/mod.ts";
export type { TelemetryDataLifecycleOutcome } from "./retention/mod.ts";

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
