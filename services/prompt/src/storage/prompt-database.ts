import {
  type DatabaseMigrationMode,
  migrateServiceDatabase,
  openServiceDatabase,
  type ServiceDatabase,
  type ServiceDatabaseDefinition,
} from "@extispex/service-storage";
import { Migration0001CreatePrompts as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-prompts.ts";
import { Migration0001CreatePrompts as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-prompts.ts";
import { Migration0002CreateBackgroundLeases as PostgresMigration0002 } from "./migrations/postgres/migration-0002-create-background-leases.ts";
import { Migration0002CreateBackgroundLeases as SqliteMigration0002 } from "./migrations/sqlite/migration-0002-create-background-leases.ts";
import { PromptLabelRecord, PromptRecord, PromptVersionRecord } from "./prompt-entities.ts";

export type PromptDatabase = ServiceDatabase;

const PROMPT_DATABASE: ServiceDatabaseDefinition = {
  entities: [PromptRecord, PromptVersionRecord, PromptLabelRecord],
  migrationsByDialect: {
    postgresql: [
      { name: "0001-create-prompts", class: PostgresMigration0001 },
      { name: "0002-create-background-leases", class: PostgresMigration0002 },
    ],
    sqlite: [
      { name: "0001-create-prompts", class: SqliteMigration0001 },
      { name: "0002-create-background-leases", class: SqliteMigration0002 },
    ],
  },
};

/**
 * Opens the Prompt database. `apply` creates it when it is missing and applies pending migrations;
 * `check` refuses it while a migration is pending, see `DatabaseMigrationMode`.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export function openPromptDatabase(
  databaseUrl: string,
  migrations: DatabaseMigrationMode = "apply",
): Promise<PromptDatabase> {
  return openServiceDatabase({ databaseUrl, migrations, ...PROMPT_DATABASE });
}

/** The `migrate` command: applies pending migrations and returns their names. */
export function migratePromptDatabase(databaseUrl: string): Promise<string[]> {
  return migrateServiceDatabase({ databaseUrl, ...PROMPT_DATABASE });
}
