import type { ServiceClient, ServiceRequestHandler } from "@extispex/service-client";
import {
  createServiceHttpApp,
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
  requireProjectAccess,
  type SecretCipher,
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
import { createTargetRepository } from "./storage/target-repository.ts";
import { parseDestinationAllowlist } from "./targets/destination-allowlist.ts";
import {
  createTargetClient,
  DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  type ResolveHostAddresses,
} from "./targets/target-client.ts";
import { registerTargetRoutes } from "./targets/target-routes.ts";

export {
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  type EvaluationWorker,
} from "./evaluation-runs/attempt-evaluation-worker.ts";
export {
  DEFAULT_TRACE_COMPLETION_TIMING,
  type TraceCompletionTiming,
} from "./iterations/trace-completion.ts";
export type {
  AttemptJob,
  EvaluateAttemptJob,
  ExecuteAttemptJob,
  JobQueue,
} from "./job-queue/job-queue.ts";
export { openJobQueue } from "./job-queue/open-job-queue.ts";
export { type EvaluationDatabase, openEvaluationDatabase } from "./storage/evaluation-database.ts";
export { DEFAULT_TARGET_TIMEOUT_MILLISECONDS } from "./targets/target-client.ts";

/** The purpose that Target credentials are encrypted for. */
export const TARGET_CREDENTIAL_CIPHER_PURPOSE = "evaluation-target-credential";

export interface EvaluationApiDependencies {
  database: EvaluationDatabase;
  jobQueue: JobQueue;
  /** Encrypts Target credentials, with the purpose {@link TARGET_CREDENTIAL_CIPHER_PURPOSE}. */
  targetCredentialCipher: SecretCipher;
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
  const targetRepository = createTargetRepository(
    dependencies.database,
    dependencies.targetCredentialCipher,
  );
  registerDatasetRoutes(app, { datasetRepository, readCurrentTime });
  registerTargetRoutes(app, { targetRepository, readCurrentTime });
  registerEvaluationRunRoutes(app, {
    datasetRepository,
    targetRepository,
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
  /** Opens Target credentials, with the purpose {@link TARGET_CREDENTIAL_CIPHER_PURPOSE}. */
  targetCredentialCipher: SecretCipher;
  /** `EVALUATION_TARGET_ALLOWED_DESTINATIONS`; an empty value allows no Target. */
  targetAllowedDestinations: string;
  targetTimeoutMilliseconds?: number;
  /** How a Target's host name is resolved; tests answer with changing addresses. */
  resolveTargetHostAddresses?: ResolveHostAddresses;
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
    targetRepository: createTargetRepository(
      dependencies.database,
      dependencies.targetCredentialCipher,
    ),
    targetClient: createTargetClient({
      allowlist: parseDestinationAllowlist(dependencies.targetAllowedDestinations),
      timeoutMilliseconds: dependencies.targetTimeoutMilliseconds ??
        DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
      resolveHostAddresses: dependencies.resolveTargetHostAddresses,
    }),
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
