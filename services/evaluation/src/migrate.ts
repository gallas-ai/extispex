/**
 * The migrate command: creates the Evaluation database when it is missing and applies pending
 * migrations, then exits. The Helm chart runs it in a Job before every install and upgrade, and the
 * services there start with `DATABASE_MIGRATIONS=check`.
 */
import { createStructuredLogger, readRequiredEnvironmentVariable } from "@extispex/service-runtime";
import { migrateEvaluationDatabase } from "./create-service.ts";

const logger = createStructuredLogger("evaluation-migrate");

const appliedMigrationNames = await migrateEvaluationDatabase(
  readRequiredEnvironmentVariable("EVALUATION_DATABASE_URL"),
);
logger.info("Database migrated", { appliedMigrationNames });
