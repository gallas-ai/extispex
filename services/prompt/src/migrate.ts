/**
 * The migrate command: creates the Prompt database when it is missing and applies pending
 * migrations, then exits. The Helm chart runs it in a Job before every install and upgrade, and the
 * services there start with `DATABASE_MIGRATIONS=check`.
 */
import { createStructuredLogger, readRequiredEnvironmentVariable } from "@extispex/service-runtime";
import { migratePromptDatabase } from "./create-service.ts";

const logger = createStructuredLogger("prompt-migrate");

const appliedMigrationNames = await migratePromptDatabase(
  readRequiredEnvironmentVariable("PROMPT_DATABASE_URL"),
);
logger.info("Database migrated", { appliedMigrationNames });
