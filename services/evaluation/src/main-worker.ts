import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityServiceTokenSource,
  createStructuredLogger,
  readPositiveIntegerEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  createEvaluationWorker,
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  DEFAULT_TRACE_COMPLETION_TIMING,
  openEvaluationDatabase,
  openJobQueue,
} from "./create-service.ts";

const logger = createStructuredLogger("evaluation-worker");

const databaseUrl = readRequiredEnvironmentVariable("EVALUATION_DATABASE_URL");
const database = await openEvaluationDatabase(databaseUrl);
const jobQueue = await openJobQueue(databaseUrl, database, logger);
const evaluationWorker = createEvaluationWorker({
  database,
  jobQueue,
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
