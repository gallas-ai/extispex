import { openServiceDatabase, type ServiceDatabase } from "@extispex/service-storage";
import {
  DatasetRecord,
  EvaluationRunRecord,
  IterationAttemptRecord,
  IterationAttemptStepRecord,
  IterationRecord,
  LlmProviderRecord,
  LlmSummarySettingsRecord,
  QueuedJobRecord,
  ReportDeliveryRecord,
  ReportSettingsRecord,
  RunTestCaseRecord,
  TargetRecord,
  TestCaseRecord,
} from "./evaluation-entities.ts";
import { Migration0001CreateEvaluation as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-evaluation.ts";
import { Migration0001CreateEvaluation as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-evaluation.ts";
import { Migration0002IndexAttemptTelemetryIds as PostgresMigration0002 } from "./migrations/postgres/migration-0002-index-attempt-telemetry-ids.ts";
import { Migration0002IndexAttemptTelemetryIds as SqliteMigration0002 } from "./migrations/sqlite/migration-0002-index-attempt-telemetry-ids.ts";
import { Migration0003AddServerDrivenExecution as PostgresMigration0003 } from "./migrations/postgres/migration-0003-add-server-driven-execution.ts";
import { Migration0003AddServerDrivenExecution as SqliteMigration0003 } from "./migrations/sqlite/migration-0003-add-server-driven-execution.ts";
import { Migration0004AddLlmProviders as PostgresMigration0004 } from "./migrations/postgres/migration-0004-add-llm-providers.ts";
import { Migration0004AddLlmProviders as SqliteMigration0004 } from "./migrations/sqlite/migration-0004-add-llm-providers.ts";
import { Migration0005AddReports as PostgresMigration0005 } from "./migrations/postgres/migration-0005-add-reports.ts";
import { Migration0005AddReports as SqliteMigration0005 } from "./migrations/sqlite/migration-0005-add-reports.ts";
import { Migration0006CreateBackgroundLeases as PostgresMigration0006 } from "./migrations/postgres/migration-0006-create-background-leases.ts";
import { Migration0006CreateBackgroundLeases as SqliteMigration0006 } from "./migrations/sqlite/migration-0006-create-background-leases.ts";

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
      IterationAttemptStepRecord,
      TargetRecord,
      ReportSettingsRecord,
      ReportDeliveryRecord,
      LlmProviderRecord,
      LlmSummarySettingsRecord,
      QueuedJobRecord,
    ],
    migrationsByDialect: {
      postgresql: [
        { name: "0001-create-evaluation", class: PostgresMigration0001 },
        { name: "0002-index-attempt-telemetry-ids", class: PostgresMigration0002 },
        { name: "0003-add-server-driven-execution", class: PostgresMigration0003 },
        { name: "0004-add-llm-providers", class: PostgresMigration0004 },
        { name: "0005-add-reports", class: PostgresMigration0005 },
        { name: "0006-create-background-leases", class: PostgresMigration0006 },
      ],
      sqlite: [
        { name: "0001-create-evaluation", class: SqliteMigration0001 },
        { name: "0002-index-attempt-telemetry-ids", class: SqliteMigration0002 },
        { name: "0003-add-server-driven-execution", class: SqliteMigration0003 },
        { name: "0004-add-llm-providers", class: SqliteMigration0004 },
        { name: "0005-add-reports", class: SqliteMigration0005 },
        { name: "0006-create-background-leases", class: SqliteMigration0006 },
      ],
    },
  });
}
