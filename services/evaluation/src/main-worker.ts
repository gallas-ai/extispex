import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityProjectLifecycleSource,
  createIdentityServiceTokenSource,
  createSecretCipher,
  createServiceTokenClient,
  createStructuredLogger,
  readDatabaseMigrationMode,
  readDataLifecycleIntervalMilliseconds,
  readOptionalEnvironmentVariable,
  readPositiveIntegerEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
  startPeriodicTask,
} from "@extispex/service-runtime";
import {
  createEvaluationWorker,
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_LLM_PROVIDER_ALLOWED_DESTINATIONS,
  DEFAULT_LLM_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  DEFAULT_REPORT_RETRY_DELAY_MILLISECONDS,
  DEFAULT_REPORT_TIMEOUT_MILLISECONDS,
  DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  DEFAULT_TRACE_COMPLETION_TIMING,
  LLM_PROVIDER_API_KEY_CIPHER_PURPOSE,
  openEvaluationDatabase,
  openJobQueue,
  REPORT_CHANNEL_CIPHER_PURPOSE,
  TARGET_CREDENTIAL_CIPHER_PURPOSE,
} from "./create-service.ts";

const logger = createStructuredLogger("evaluation-worker");

const databaseUrl = readRequiredEnvironmentVariable("EVALUATION_DATABASE_URL");
const database = await openEvaluationDatabase(
  databaseUrl,
  readDatabaseMigrationMode(),
);
const jobQueue = await openJobQueue(databaseUrl, database, logger);
const identityClient = createHttpServiceClient(readRequiredEnvironmentVariable("IDENTITY_URL"));
const serviceTokens = createIdentityServiceTokenSource({
  identityClient,
  clientId: "evaluation",
  clientSecret: readRequiredEnvironmentVariable("IDENTITY_CLIENT_SECRET"),
});
const dataLifecycleIntervalMilliseconds = readDataLifecycleIntervalMilliseconds();
const masterKey = readRequiredEnvironmentVariable("MASTER_KEY");
const evaluationWorker = createEvaluationWorker({
  database,
  jobQueue,
  // The standard proxy variables, in either case, as curl reads them.
  proxy: {
    httpsProxy: readOptionalEnvironmentVariable("HTTPS_PROXY") ??
      readOptionalEnvironmentVariable("https_proxy"),
    httpProxy: readOptionalEnvironmentVariable("HTTP_PROXY") ??
      readOptionalEnvironmentVariable("http_proxy"),
    noProxy: readOptionalEnvironmentVariable("NO_PROXY") ??
      readOptionalEnvironmentVariable("no_proxy"),
  },
  targetCredentialCipher: await createSecretCipher(masterKey, TARGET_CREDENTIAL_CIPHER_PURPOSE),
  reportChannelCipher: await createSecretCipher(masterKey, REPORT_CHANNEL_CIPHER_PURPOSE),
  // Report channels are addresses that users supply too, so nothing is allowed by default.
  reportAllowedDestinations: readOptionalEnvironmentVariable(
    "EVALUATION_REPORT_ALLOWED_DESTINATIONS",
  ) ?? "",
  publicUiUrl: readOptionalEnvironmentVariable("PUBLIC_UI_URL") ?? null,
  reportRetryDelayMilliseconds: readPositiveIntegerEnvironmentVariable(
    "EVALUATION_REPORT_RETRY_DELAY_MILLISECONDS",
    DEFAULT_REPORT_RETRY_DELAY_MILLISECONDS,
  ),
  reportTimeoutMilliseconds: readPositiveIntegerEnvironmentVariable(
    "EVALUATION_REPORT_TIMEOUT_MILLISECONDS",
    DEFAULT_REPORT_TIMEOUT_MILLISECONDS,
  ),
  llmProviderApiKeyCipher: await createSecretCipher(
    masterKey,
    LLM_PROVIDER_API_KEY_CIPHER_PURPOSE,
  ),
  // The public providers by default; Azure OpenAI and local models need an operator's entry.
  llmProviderAllowedDestinations: readOptionalEnvironmentVariable(
    "EVALUATION_LLM_PROVIDER_ALLOWED_DESTINATIONS",
  ) ?? DEFAULT_LLM_PROVIDER_ALLOWED_DESTINATIONS,
  llmTimeoutMilliseconds: readPositiveIntegerEnvironmentVariable(
    "EVALUATION_LLM_TIMEOUT_MILLISECONDS",
    DEFAULT_LLM_TIMEOUT_MILLISECONDS,
  ),
  // Nothing is allowed unless an operator says so: Targets are URLs that users supply.
  targetAllowedDestinations: readOptionalEnvironmentVariable(
    "EVALUATION_TARGET_ALLOWED_DESTINATIONS",
  ) ?? "",
  targetTimeoutMilliseconds: readPositiveIntegerEnvironmentVariable(
    "EVALUATION_TARGET_TIMEOUT_MILLISECONDS",
    DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  ),
  telemetryService: createHttpServiceClient(readRequiredEnvironmentVariable("TELEMETRY_URL")),
  promptService: createHttpServiceClient(readRequiredEnvironmentVariable("PROMPT_URL")),
  serviceTokens,
  projectLifecycle: createIdentityProjectLifecycleSource(
    createServiceTokenClient(identityClient, serviceTokens),
  ),
  dataLifecycleIntervalMilliseconds,
  logger,
  traceCompletionTiming: {
    pollIntervalMilliseconds: readPositiveIntegerEnvironmentVariable(
      "EVALUATION_TELEMETRY_POLL_INTERVAL_MILLISECONDS",
      DEFAULT_TRACE_COMPLETION_TIMING.pollIntervalMilliseconds,
    ),
    rootSpanSettleMilliseconds: readPositiveIntegerEnvironmentVariable(
      "EVALUATION_ROOT_SPAN_SETTLE_MILLISECONDS",
      DEFAULT_TRACE_COMPLETION_TIMING.rootSpanSettleMilliseconds,
    ),
    rootSpanTimeoutMilliseconds: readPositiveIntegerEnvironmentVariable(
      "EVALUATION_ROOT_SPAN_TIMEOUT_MILLISECONDS",
      DEFAULT_TRACE_COMPLETION_TIMING.rootSpanTimeoutMilliseconds,
    ),
  },
  regexTimeoutMilliseconds: readPositiveIntegerEnvironmentVariable(
    "EVALUATION_REGEX_TIMEOUT_MILLISECONDS",
    DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  ),
  inactiveRunTimeoutMilliseconds: readPositiveIntegerEnvironmentVariable(
    "EVALUATION_INACTIVE_RUN_TIMEOUT_MILLISECONDS",
    DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  ),
});
await evaluationWorker.start();
const dataLifecycle = startPeriodicTask({
  taskName: "data lifecycle",
  intervalMilliseconds: dataLifecycleIntervalMilliseconds,
  runTask: evaluationWorker.runDataLifecycle,
  logger,
});
logger.info("Evaluation worker started");

runOnTerminationSignal(logger, async () => {
  await dataLifecycle.stop();
  await evaluationWorker.stop();
  await database.close();
});
