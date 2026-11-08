import {
  createStructuredLogger,
  readOptionalEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  createEvaluationWorker,
  DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  openEvaluationDatabase,
  openJobQueue,
} from "./create-service.ts";

const logger = createStructuredLogger("evaluation-worker");

function readPositiveInteger(variableName: string, defaultValue: number): number {
  const configuredValue = readOptionalEnvironmentVariable(variableName);
  if (configuredValue === undefined) return defaultValue;
  const parsedValue = Number(configuredValue);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${variableName} must be a positive whole number.`);
  }
  return parsedValue;
}

const databaseUrl = readRequiredEnvironmentVariable("EVALUATION_DATABASE_URL");
const database = await openEvaluationDatabase(databaseUrl);
const jobQueue = await openJobQueue(databaseUrl, database, logger);
const evaluationWorker = createEvaluationWorker({
  database,
  jobQueue,
  logger,
  regexTimeoutMilliseconds: readPositiveInteger(
    "EVALUATION_REGEX_TIMEOUT_MILLISECONDS",
    DEFAULT_REGEX_TIMEOUT_MILLISECONDS,
  ),
  inactiveRunTimeoutMilliseconds: readPositiveInteger(
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
