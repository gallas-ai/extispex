import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityServiceTokenSource,
  createSecretCipher,
  createStructuredLogger,
  readOptionalEnvironmentVariable,
  readPositiveIntegerEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  createEvaluationWorker,
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  DEFAULT_TRACE_COMPLETION_TIMING,
  openEvaluationDatabase,
  openJobQueue,
  TARGET_CREDENTIAL_CIPHER_PURPOSE,
} from "./create-service.ts";

const logger = createStructuredLogger("evaluation-worker");

const databaseUrl = readRequiredEnvironmentVariable("EVALUATION_DATABASE_URL");
const database = await openEvaluationDatabase(databaseUrl);
const jobQueue = await openJobQueue(databaseUrl, database, logger);
const evaluationWorker = createEvaluationWorker({
  database,
  jobQueue,
  targetCredentialCipher: await createSecretCipher(
    readRequiredEnvironmentVariable("MASTER_KEY"),
    TARGET_CREDENTIAL_CIPHER_PURPOSE,
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
  serviceTokens: createIdentityServiceTokenSource({
    identityClient: createHttpServiceClient(readRequiredEnvironmentVariable("IDENTITY_URL")),
    clientId: "evaluation",
    clientSecret: readRequiredEnvironmentVariable("IDENTITY_CLIENT_SECRET"),
  }),
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
logger.info("Evaluation worker started");

runOnTerminationSignal(logger, async () => {
  await evaluationWorker.stop();
  await database.close();
});
