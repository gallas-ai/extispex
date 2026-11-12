import type { ServiceClient, ServiceRequestHandler } from "@extispex/service-client";
import { createBackgroundLease } from "@extispex/service-storage";
import {
  createDeletedProjectRemoval,
  createServiceHttpApp,
  DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS,
  type DeletedProjectRemovalOutcome,
  type ProjectAccessEnvironment,
  type ProjectLifecycleSource,
  type RequestAuthenticator,
  requireProjectAccess,
  type SecretCipher,
  type ServiceTokenSource,
  type StructuredLogger,
} from "@extispex/service-runtime";
import { registerDatasetRoutes } from "./datasets/mod.ts";
import {
  createAttemptEvaluationWorker,
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  type EvaluationWorker,
  registerEvaluationRunRoutes,
} from "./evaluation-runs/mod.ts";
import {
  createTelemetryClient,
  DEFAULT_TRACE_COMPLETION_TIMING,
  type TraceCompletionTiming,
} from "./iterations/mod.ts";
import type { JobQueue } from "./job-queue/mod.ts";
import {
  createLlmProviderClient,
  DEFAULT_LLM_TIMEOUT_MILLISECONDS,
  registerLlmProviderRoutes,
} from "./llm-providers/mod.ts";
import { createPromptClient } from "./prompts/mod.ts";
import {
  createReportDeliverer,
  createReportSender,
  DEFAULT_REPORT_RETRY_DELAY_MILLISECONDS,
  DEFAULT_REPORT_TIMEOUT_MILLISECONDS,
  registerReportSettingsRoutes,
} from "./reports/mod.ts";
import {
  createDatasetRepository,
  createEvaluationRunRepository,
  createLlmProviderRepository,
  createReportDeliveryRepository,
  createReportSettingsRepository,
  createTargetRepository,
  type EvaluationDatabase,
  removeEvaluationProjectData,
} from "./storage/mod.ts";
import {
  createTargetClient,
  DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  parseDestinationAllowlist,
  registerTargetRoutes,
  type ResolveHostAddresses,
} from "./targets/mod.ts";

export {
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  type EvaluationWorker,
} from "./evaluation-runs/mod.ts";
export { DEFAULT_TRACE_COMPLETION_TIMING, type TraceCompletionTiming } from "./iterations/mod.ts";
export {
  type AttemptJob,
  type DeliverReportJob,
  type EvaluateAttemptJob,
  type EvaluationJob,
  type ExecuteAttemptJob,
  type JobQueue,
  openJobQueue,
} from "./job-queue/mod.ts";
export {
  DEFAULT_REPORT_RETRY_DELAY_MILLISECONDS,
  DEFAULT_REPORT_TIMEOUT_MILLISECONDS,
  REPORT_DELIVERY_ATTEMPTS,
} from "./reports/mod.ts";
export { DEFAULT_LLM_TIMEOUT_MILLISECONDS } from "./llm-providers/mod.ts";
export { type EvaluationDatabase, openEvaluationDatabase } from "./storage/mod.ts";
export { DEFAULT_TARGET_TIMEOUT_MILLISECONDS } from "./targets/mod.ts";

/** The purpose that Target credentials are encrypted for. */
export const TARGET_CREDENTIAL_CIPHER_PURPOSE = "evaluation-target-credential";

/** The purpose that a Report channel's SMTP password and Teams webhook URL are encrypted for. */
export const REPORT_CHANNEL_CIPHER_PURPOSE = "evaluation-report-channel";
/** The purpose that LLM provider API keys are encrypted for, see ADR 0013. */
export const LLM_PROVIDER_API_KEY_CIPHER_PURPOSE = "evaluation-llm-provider-api-key";

/**
 * The public providers' addresses, which separate services may call unless an operator sets
 * `EVALUATION_LLM_PROVIDER_ALLOWED_DESTINATIONS`. Azure OpenAI and local models need their own
 * entries.
 */
export const DEFAULT_LLM_PROVIDER_ALLOWED_DESTINATIONS =
  "api.openai.com:443,api.anthropic.com:443,api.typesafe.ai:443";

export interface EvaluationApiDependencies {
  database: EvaluationDatabase;
  jobQueue: JobQueue;
  /** Encrypts Target credentials, with the purpose {@link TARGET_CREDENTIAL_CIPHER_PURPOSE}. */
  targetCredentialCipher: SecretCipher;
  /** Encrypts Report channel secrets, with the purpose {@link REPORT_CHANNEL_CIPHER_PURPOSE}. */
  reportChannelCipher: SecretCipher;
  /** Encrypts LLM provider API keys, with the purpose {@link LLM_PROVIDER_API_KEY_CIPHER_PURPOSE}. */
  llmProviderApiKeyCipher: SecretCipher;
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
  registerReportSettingsRoutes(app, {
    reportSettingsRepository: createReportSettingsRepository(
      dependencies.database,
      dependencies.reportChannelCipher,
    ),
    readCurrentTime,
  });
  registerLlmProviderRoutes(app, {
    llmProviderRepository: createLlmProviderRepository(
      dependencies.database,
      dependencies.llmProviderApiKeyCipher,
    ),
    readCurrentTime,
  });
  registerEvaluationRunRoutes(app, {
    datasetRepository,
    targetRepository,
    evaluationRunRepository: createEvaluationRunRepository(dependencies.database),
    reportDeliveryRepository: createReportDeliveryRepository(dependencies.database),
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
  /** Opens Report channel secrets, with the purpose {@link REPORT_CHANNEL_CIPHER_PURPOSE}. */
  reportChannelCipher: SecretCipher;
  /** `EVALUATION_REPORT_ALLOWED_DESTINATIONS`; an empty value allows no SMTP server or webhook. */
  reportAllowedDestinations: string;
  /** `PUBLIC_UI_URL`, where people open the UI, for the links in a Report. */
  publicUiUrl?: string | null;
  reportRetryDelayMilliseconds?: number;
  reportTimeoutMilliseconds?: number;
  /** Opens LLM provider API keys, with the purpose {@link LLM_PROVIDER_API_KEY_CIPHER_PURPOSE}. */
  llmProviderApiKeyCipher: SecretCipher;
  /** `EVALUATION_LLM_PROVIDER_ALLOWED_DESTINATIONS`; an empty value allows no provider. */
  llmProviderAllowedDestinations: string;
  llmTimeoutMilliseconds?: number;
  /** How a provider's host name is resolved; tests answer with fixed addresses. */
  resolveLlmProviderHostAddresses?: ResolveHostAddresses;
  /** The wait before retrying a busy provider; tests shorten it. */
  llmRetryDelayMilliseconds?: number;
  /** Reaches Telemetry's internal API, with the service token that `serviceTokens` provides. */
  telemetryService: ServiceClient;
  /** Reaches the Prompt service's API for Prompt Versions, with a service token as well. */
  promptService: ServiceClient;
  serviceTokens: ServiceTokenSource;
  /** Identity's deleted Projects, asked with this service's token. */
  projectLifecycle: ProjectLifecycleSource;
  logger: StructuredLogger;
  traceCompletionTiming?: Partial<TraceCompletionTiming>;
  regexTimeoutMilliseconds?: number;
  inactiveRunTimeoutMilliseconds?: number;
  readCurrentTime?: () => Date;
  /** How often `runDataLifecycle` runs; its lease lasts two intervals. */
  dataLifecycleIntervalMilliseconds?: number;
  /** Who holds the data lifecycle's lease; one ID per process by default. */
  leaseHolder?: string;
}

export interface EvaluationWorkerService extends EvaluationWorker {
  /**
   * One run of the periodic data work, if this worker gets the lease: removes deleted Projects'
   * Datasets, runs and Targets. `main-worker.ts` runs it every
   * `DATA_LIFECYCLE_INTERVAL_MILLISECONDS`. A lease rather than the job queue, so that it works
   * like the other services and needs no job kind of its own in pg-boss and the SQLite queue.
   */
  runDataLifecycle(): Promise<DeletedProjectRemovalOutcome>;
}

export function createEvaluationWorker(
  dependencies: EvaluationWorkerServiceDependencies,
): EvaluationWorkerService {
  const readCurrentTime = dependencies.readCurrentTime ?? (() => new Date());
  const lease = createBackgroundLease(dependencies.database, {
    name: "data-lifecycle",
    holder: dependencies.leaseHolder ?? crypto.randomUUID(),
    durationMilliseconds: 2 *
      (dependencies.dataLifecycleIntervalMilliseconds ??
        DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS),
  });
  const runDataLifecycle = createDeletedProjectRemoval({
    tryAcquireLease: lease.tryAcquire,
    projectLifecycle: dependencies.projectLifecycle,
    removeProjectData: (projectId) => removeEvaluationProjectData(dependencies.database, projectId),
    logger: dependencies.logger,
    readCurrentTime,
  });
  const logger = dependencies.logger;
  const worker = createAttemptEvaluationWorker({
    reportDeliverer: createReportDeliverer({
      reportDeliveryRepository: createReportDeliveryRepository(dependencies.database),
      reportSettingsRepository: createReportSettingsRepository(
        dependencies.database,
        dependencies.reportChannelCipher,
      ),
      reportSender: createReportSender({
        allowlist: parseDestinationAllowlist(
          dependencies.reportAllowedDestinations,
          "EVALUATION_REPORT_ALLOWED_DESTINATIONS",
        ),
        timeoutMilliseconds: dependencies.reportTimeoutMilliseconds ??
          DEFAULT_REPORT_TIMEOUT_MILLISECONDS,
      }),
      jobQueue: dependencies.jobQueue,
      publicUiUrl: dependencies.publicUiUrl?.replace(/\/+$/, "") || null,
      retryDelayMilliseconds: dependencies.reportRetryDelayMilliseconds ??
        DEFAULT_REPORT_RETRY_DELAY_MILLISECONDS,
      logger,
      readCurrentTime,
    }),
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
    llmProviderRepository: createLlmProviderRepository(
      dependencies.database,
      dependencies.llmProviderApiKeyCipher,
    ),
    llmProviderClient: createLlmProviderClient({
      allowlist: parseDestinationAllowlist(dependencies.llmProviderAllowedDestinations),
      timeoutMilliseconds: dependencies.llmTimeoutMilliseconds ?? DEFAULT_LLM_TIMEOUT_MILLISECONDS,
      resolveHostAddresses: dependencies.resolveLlmProviderHostAddresses,
      retryDelayMilliseconds: dependencies.llmRetryDelayMilliseconds,
    }),
    promptClient: createPromptClient(dependencies.promptService, dependencies.serviceTokens),
    telemetryClient: createTelemetryClient(
      dependencies.telemetryService,
      dependencies.serviceTokens,
    ),
    traceCompletionTiming: {
      ...DEFAULT_TRACE_COMPLETION_TIMING,
      ...dependencies.traceCompletionTiming,
    },
    logger,
    regexTimeoutMilliseconds: dependencies.regexTimeoutMilliseconds ??
      DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
    inactiveRunTimeoutMilliseconds: dependencies.inactiveRunTimeoutMilliseconds ??
      DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
    readCurrentTime,
  });
  return { ...worker, runDataLifecycle };
}
