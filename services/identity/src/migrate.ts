/**
 * The migrate command: creates the Identity database when it is missing and applies pending
 * migrations, then exits. The Helm chart runs it in a Job before every install and upgrade, and the
 * services there start with `DATABASE_MIGRATIONS=check`.
 */
import { createStructuredLogger, readRequiredEnvironmentVariable } from "@extispex/service-runtime";
import { migrateIdentityDatabase } from "./create-service.ts";

const logger = createStructuredLogger("identity-migrate");

const appliedMigrationNames = await migrateIdentityDatabase(
  readRequiredEnvironmentVariable("IDENTITY_DATABASE_URL"),
);
logger.info("Database migrated", { appliedMigrationNames });
