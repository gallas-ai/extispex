import { openServiceDatabase, type ServiceDatabase } from "@extispex/service-storage";
import { Migration0001CreateProjects as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-projects.ts";
import { Migration0001CreateProjects as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-projects.ts";
import { ApiKeyRecord, ProjectRecord } from "./identity-entities.ts";

export type IdentityDatabase = ServiceDatabase;

/**
 * Opens the Identity database and applies pending migrations.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export function openIdentityDatabase(databaseUrl: string): Promise<IdentityDatabase> {
  return openServiceDatabase({
    databaseUrl,
    entities: [ProjectRecord, ApiKeyRecord],
    migrationsByDialect: {
      postgresql: [{ name: "0001-create-projects", class: PostgresMigration0001 }],
      sqlite: [{ name: "0001-create-projects", class: SqliteMigration0001 }],
    },
  });
}
