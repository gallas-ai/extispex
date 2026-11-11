import { dropDailyPartitionsEndingBefore } from "./daily-partitions.ts";
import {
  CorrelationEvaluationRecord,
  formatUnixNanosecondsForStorage,
} from "./span-record-entity.ts";
import type { TelemetryDatabase } from "./telemetry-database.ts";

/** The tables that hold records by the day of their time, partitioned on PostgreSQL. */
export const DAILY_RECORD_TABLES = ["logs", "metric_points"] as const;

/** Every table that keeps a Project's telemetry. */
const PROJECT_TABLES = [
  "spans",
  "correlation_evaluations",
  "logs",
  "metric_points",
  "metric_series",
  "rejection_counts",
];

export interface ExpiredRecordsCutoff {
  projectId: string;
  /** Records whose own time is earlier than this are expired. */
  cutoffUnixNano: bigint;
  /**
   * Whether to delete expired Log Records and metric points row by row. On PostgreSQL that is
   * left to dropping whole days when no Project keeps them longer, see ADR 0018.
   */
  deletesDailyRecords: boolean;
}

/** Removing telemetry: a deleted Project's, expired records, and old rejected counts. */
export interface RetentionRepository {
  removeProjectData(projectId: string): Promise<void>;
  /**
   * Deletes a Project's spans, Log Records and metric points older than the cutoff by their own
   * time, the Time Series last seen before it, and the evaluation marks older than it.
   */
  deleteExpiredRecords(cutoff: ExpiredRecordsCutoff): Promise<void>;
  /** Drops whole days of Log Records and metric points before the cutoff; only on PostgreSQL. */
  dropDaysEndingBefore(cutoffUnixNano: bigint): Promise<string[]>;
  deleteRejectionCountsBefore(cutoff: Date): Promise<void>;
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export function createRetentionRepository(database: TelemetryDatabase): RetentionRepository {
  return {
    async removeProjectData(projectId) {
      await database.orm.em.fork().transactional(async (entityManager) => {
        for (const tableName of PROJECT_TABLES) {
          await entityManager.execute(`delete from ${tableName} where project_id = ?`, [projectId]);
        }
      });
    },

    async deleteExpiredRecords({ projectId, cutoffUnixNano, deletesDailyRecords }) {
      const storedCutoff = formatUnixNanosecondsForStorage(cutoffUnixNano);
      const entityManager = database.orm.em.fork();
      await entityManager.execute(
        "delete from spans where project_id = ? and start_time_unix_nano < ?",
        [projectId, storedCutoff],
      );
      await entityManager.nativeDelete(CorrelationEvaluationRecord, {
        projectId,
        evaluatedAt: { $lt: new Date(Number(cutoffUnixNano / NANOSECONDS_PER_MILLISECOND)) },
      });
      if (deletesDailyRecords) {
        for (const tableName of DAILY_RECORD_TABLES) {
          await entityManager.execute(
            `delete from ${tableName} where project_id = ? and time_unix_nano < ?`,
            [projectId, storedCutoff],
          );
        }
      }
      await entityManager.execute(
        "delete from metric_series where project_id = ? and last_seen_unix_nano < ?",
        [projectId, storedCutoff],
      );
    },

    async dropDaysEndingBefore(cutoffUnixNano) {
      const droppedPartitions: string[] = [];
      for (const tableName of DAILY_RECORD_TABLES) {
        droppedPartitions.push(
          ...await dropDailyPartitionsEndingBefore(database, tableName, cutoffUnixNano),
        );
      }
      return droppedPartitions;
    },

    async deleteRejectionCountsBefore(cutoff) {
      // Hour starts are ISO times of one length, which sort like the times themselves.
      await database.orm.em.fork().execute("delete from rejection_counts where hour_start < ?", [
        cutoff.toISOString(),
      ]);
    },
  };
}
