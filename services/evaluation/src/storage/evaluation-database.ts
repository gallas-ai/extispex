import { openServiceDatabase, type ServiceDatabase } from "@extispex/service-storage";
import {
  DatasetRecord,
  EvaluationRunRecord,
  IterationAttemptRecord,
  IterationRecord,
  QueuedJobRecord,
  RunTestCaseRecord,
  TestCaseRecord,
} from "./evaluation-entities.ts";
import { Migration0001CreateEvaluation as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-evaluation.ts";
import { Migration0001CreateEvaluation as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-evaluation.ts";

export type EvaluationDatabase = ServiceDatabase;

/**
 * Opens the Evaluation database and applies pending migrations.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export function openEvaluationDatabase(databaseUrl: string): Promise<EvaluationDatabase> {
  return openServiceDatabase({
    databaseUrl,
    entities: [
      DatasetRecord,
      TestCaseRecord,
      EvaluationRunRecord,
      RunTestCaseRecord,
      IterationRecord,
      IterationAttemptRecord,
      QueuedJobRecord,
    ],
    migrationsByDialect: {
      postgresql: [{ name: "0001-create-evaluation", class: PostgresMigration0001 }],
      sqlite: [{ name: "0001-create-evaluation", class: SqliteMigration0001 }],
    },
  });
}
