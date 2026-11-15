/**
 * The reseal command: after the master key changed, seals Identity's private signing keys again
 * with `MASTER_KEY`, opening them with `PREVIOUS_MASTER_KEY`. Safe to run again and alongside
 * running replicas. The Helm chart runs it in a Job after an upgrade that sets a previous key.
 */
import {
  createStructuredLogger,
  readDatabaseMigrationMode,
  readMasterKeys,
  readRequiredEnvironmentVariable,
} from "@extispex/service-runtime";
import {
  createSigningKeyCipher,
  openIdentityDatabase,
  resealSigningKeys,
} from "./create-service.ts";

const logger = createStructuredLogger("identity-reseal-secrets");

const signingKeyCipher = await createSigningKeyCipher(readMasterKeys());
const database = await openIdentityDatabase(
  readRequiredEnvironmentVariable("IDENTITY_DATABASE_URL"),
  readDatabaseMigrationMode(),
);
try {
  const signingKeys = await resealSigningKeys(database, signingKeyCipher);
  logger.info("Sealed stored secrets with the current master key", {
    masterKeyId: signingKeyCipher.currentKeyId,
    signingKeys,
  });
} finally {
  await database.close();
}
