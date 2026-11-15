/**
 * The reseal command: after the master key changed, seals Evaluation's stored secrets (Target
 * credentials, Report channel secrets and LLM provider API keys) again with `MASTER_KEY`, opening
 * them with `PREVIOUS_MASTER_KEY`. Safe to run again and alongside running replicas. The Helm chart
 * runs it in a Job after an upgrade that sets a previous key.
 */
import {
  createStructuredLogger,
  readDatabaseMigrationMode,
  readMasterKeys,
  readRequiredEnvironmentVariable,
} from "@extispex/service-runtime";
import {
  createEvaluationSecretCiphers,
  openEvaluationDatabase,
  resealEvaluationSecrets,
} from "./create-service.ts";

const logger = createStructuredLogger("evaluation-reseal-secrets");

const ciphers = await createEvaluationSecretCiphers(readMasterKeys());
const database = await openEvaluationDatabase(
  readRequiredEnvironmentVariable("EVALUATION_DATABASE_URL"),
  readDatabaseMigrationMode(),
);
try {
  const outcome = await resealEvaluationSecrets(database, ciphers);
  logger.info("Sealed stored secrets with the current master key", {
    masterKeyId: ciphers.targetCredential.currentKeyId,
    ...outcome,
  });
} finally {
  await database.close();
}
