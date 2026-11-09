import { openServiceDatabase, type ServiceDatabase } from "@extispex/service-storage";
import { Migration0001CreateSpans as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-spans.ts";
import { Migration0001CreateSpans as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-spans.ts";
import { Migration0002CreateCorrelationEvaluations as PostgresMigration0002 } from "./migrations/postgres/migration-0002-create-correlation-evaluations.ts";
import { Migration0002CreateCorrelationEvaluations as SqliteMigration0002 } from "./migrations/sqlite/migration-0002-create-correlation-evaluations.ts";
import { CorrelationEvaluationRecord, SpanRecord } from "./span-record-entity.ts";

export type TelemetryDatabase = ServiceDatabase;

/**
 * Opens the Telemetry database and applies pending migrations.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export function openTelemetryDatabase(databaseUrl: string): Promise<TelemetryDatabase> {
  return openServiceDatabase({
    databaseUrl,
    entities: [SpanRecord, CorrelationEvaluationRecord],
    migrationsByDialect: {
      postgresql: [
        { name: "0001-create-spans", class: PostgresMigration0001 },
        { name: "0002-create-correlation-evaluations", class: PostgresMigration0002 },
      ],
      sqlite: [
        { name: "0001-create-spans", class: SqliteMigration0001 },
        { name: "0002-create-correlation-evaluations", class: SqliteMigration0002 },
      ],
    },
  });
}
