import {
  type DatabaseMigrationMode,
  migrateServiceDatabase,
  openServiceDatabase,
  type ServiceDatabase,
  type ServiceDatabaseDefinition,
} from "@extispex/service-storage";
import { Migration0001CreateSpans as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-spans.ts";
import { Migration0001CreateSpans as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-spans.ts";
import { Migration0002CreateCorrelationEvaluations as PostgresMigration0002 } from "./migrations/postgres/migration-0002-create-correlation-evaluations.ts";
import { Migration0002CreateCorrelationEvaluations as SqliteMigration0002 } from "./migrations/sqlite/migration-0002-create-correlation-evaluations.ts";
import { Migration0003CreateLogs as PostgresMigration0003 } from "./migrations/postgres/migration-0003-create-logs.ts";
import { Migration0003CreateLogs as SqliteMigration0003 } from "./migrations/sqlite/migration-0003-create-logs.ts";
import { Migration0004CreateMetrics as PostgresMigration0004 } from "./migrations/postgres/migration-0004-create-metrics.ts";
import { Migration0004CreateMetrics as SqliteMigration0004 } from "./migrations/sqlite/migration-0004-create-metrics.ts";
import { Migration0005CreateBackgroundLeases as PostgresMigration0005 } from "./migrations/postgres/migration-0005-create-background-leases.ts";
import { Migration0005CreateBackgroundLeases as SqliteMigration0005 } from "./migrations/sqlite/migration-0005-create-background-leases.ts";
import { CorrelationEvaluationRecord, SpanRecord } from "./span-record-entity.ts";

export type TelemetryDatabase = ServiceDatabase;

const TELEMETRY_DATABASE: ServiceDatabaseDefinition = {
  entities: [SpanRecord, CorrelationEvaluationRecord],
  migrationsByDialect: {
    postgresql: [
      { name: "0001-create-spans", class: PostgresMigration0001 },
      { name: "0002-create-correlation-evaluations", class: PostgresMigration0002 },
      { name: "0003-create-logs", class: PostgresMigration0003 },
      { name: "0004-create-metrics", class: PostgresMigration0004 },
      { name: "0005-create-background-leases", class: PostgresMigration0005 },
    ],
    sqlite: [
      { name: "0001-create-spans", class: SqliteMigration0001 },
      { name: "0002-create-correlation-evaluations", class: SqliteMigration0002 },
      { name: "0003-create-logs", class: SqliteMigration0003 },
      { name: "0004-create-metrics", class: SqliteMigration0004 },
      { name: "0005-create-background-leases", class: SqliteMigration0005 },
    ],
  },
};

/**
 * Opens the Telemetry database. `apply` creates it when it is missing and applies pending migrations;
 * `check` refuses it while a migration is pending, see `DatabaseMigrationMode`.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export function openTelemetryDatabase(
  databaseUrl: string,
  migrations: DatabaseMigrationMode = "apply",
): Promise<TelemetryDatabase> {
  return openServiceDatabase({ databaseUrl, migrations, ...TELEMETRY_DATABASE });
}

/** The `migrate` command: applies pending migrations and returns their names. */
export function migrateTelemetryDatabase(databaseUrl: string): Promise<string[]> {
  return migrateServiceDatabase({ databaseUrl, ...TELEMETRY_DATABASE });
}
