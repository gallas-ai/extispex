import type { ServiceClient, ServiceRequestHandler } from "@extispex/service-client";
import {
  createServiceHttpApp,
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
  requireProjectAccess,
  type ServiceTokenSource,
  type StructuredLogger,
} from "@extispex/service-runtime";
import { registerDatasetRoutes } from "./datasets/dataset-routes.ts";
import {
  createAttemptEvaluationWorker,
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  type EvaluationWorker,
} from "./evaluation-runs/attempt-evaluation-worker.ts";
import { registerEvaluationRunRoutes } from "./evaluation-runs/evaluation-run-routes.ts";
import { createTelemetryClient } from "./iterations/telemetry-client.ts";
import {
  DEFAULT_TRACE_COMPLETION_TIMING,
  type TraceCompletionTiming,
} from "./iterations/trace-completion.ts";
import type { JobQueue } from "./job-queue/job-queue.ts";
import { createDatasetRepository } from "./storage/dataset-repository.ts";
import type { EvaluationDatabase } from "./storage/evaluation-database.ts";
import { createEvaluationRunRepository } from "./storage/evaluation-run-repository.ts";

export {
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  type EvaluationWorker,
} from "./evaluation-runs/attempt-evaluation-worker.ts";
export {
  DEFAULT_TRACE_COMPLETION_TIMING,
  type TraceCompletionTiming,
} from "./iterations/trace-completion.ts";
export type { EvaluateAttemptJob, JobQueue } from "./job-queue/job-queue.ts";
export { openJobQueue } from "./job-queue/open-job-queue.ts";
export { type EvaluationDatabase, openEvaluationDatabase } from "./storage/evaluation-database.ts";

export interface EvaluationApiDependencies {
  database: EvaluationDatabase;
  jobQueue: JobQueue;
  requestAuthenticator: RequestAuthenticator;
  logger: StructuredLogger;
  readCurrentTime?: () => Date;
}

export interface EvaluationApiService {
  /** Handles the Evaluation REST API, the OpenAPI document and health checks. */
  handleRequest: ServiceRequestHandler;
}

export function createEvaluationApiService(
  dependencies: EvaluationApiDependencies,
): EvaluationApiService {
  const readCurrentTime = dependencies.readCurrentTime ?? (() => new Date());
  const app = createServiceHttpApp<ProjectAccessEnvironment>({
    apiTitle: "Extispex: Evaluation API",
    logger: dependencies.logger,
  });
  // Reading takes the Role viewer, and every change editor.
  app.use("/v1/*", requireProjectAccess(dependencies.requestAuthenticator));
  const datasetRepository = createDatasetRepository(dependencies.database);
  registerDatasetRoutes(app, { datasetRepository, readCurrentTime });
  registerEvaluationRunRoutes(app, {
    datasetRepository,
    evaluationRunRepository: createEvaluationRunRepository(dependencies.database),
    jobQueue: dependencies.jobQueue,
    logger: dependencies.logger,
    readCurrentTime,
  });
  return { handleRequest: (request) => app.fetch(request) };
}

export interface EvaluationWorkerServiceDependencies {
  database: EvaluationDatabase;
  jobQueue: JobQueue;
  /** Reaches Telemetry's internal API, with the service token that `serviceTokens` provides. */
  telemetryService: ServiceClient;
  serviceTokens: ServiceTokenSource;
  logger: StructuredLogger;
  traceCompletionTiming?: Partial<TraceCompletionTiming>;
  regexTimeoutMilliseconds?: number;
  inactiveRunTimeoutMilliseconds?: number;
  readCurrentTime?: () => Date;
}

export function createEvaluationWorker(
  dependencies: EvaluationWorkerServiceDependencies,
): EvaluationWorker {
  return createAttemptEvaluationWorker({
    evaluationRunRepository: createEvaluationRunRepository(dependencies.database),
    jobQueue: dependencies.jobQueue,
    telemetryClient: createTelemetryClient(
      dependencies.telemetryService,
      dependencies.serviceTokens,
    ),
    traceCompletionTiming: {
      ...DEFAULT_TRACE_COMPLETION_TIMING,
      ...dependencies.traceCompletionTiming,
    },
    logger: dependencies.logger,
    regexTimeoutMilliseconds: dependencies.regexTimeoutMilliseconds ??
      DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
    inactiveRunTimeoutMilliseconds: dependencies.inactiveRunTimeoutMilliseconds ??
      DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
    readCurrentTime: dependencies.readCurrentTime ?? (() => new Date()),
  });
}
