import { openServiceDatabase, type ServiceDatabase } from "@extispex/service-storage";
import { Migration0001CreatePrompts as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-prompts.ts";
import { Migration0001CreatePrompts as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-prompts.ts";
import { PromptLabelRecord, PromptRecord, PromptVersionRecord } from "./prompt-entities.ts";

export type PromptDatabase = ServiceDatabase;

/**
 * Opens the Prompt database and applies pending migrations.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export function openPromptDatabase(databaseUrl: string): Promise<PromptDatabase> {
  return openServiceDatabase({
    databaseUrl,
    entities: [PromptRecord, PromptVersionRecord, PromptLabelRecord],
    migrationsByDialect: {
      postgresql: [{ name: "0001-create-prompts", class: PostgresMigration0001 }],
      sqlite: [{ name: "0001-create-prompts", class: SqliteMigration0001 }],
    },
  });
}
