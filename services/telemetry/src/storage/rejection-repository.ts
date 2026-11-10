import type { RejectedTelemetry, RejectedTelemetrySummary } from "@extispex/contracts";
import { makeTextStorable } from "../ingestion/stored-text.ts";
import type { TelemetryDatabase } from "./telemetry-database.ts";

export type TelemetrySignal = "spans" | "logs" | "metrics";

export interface RecordedRejections {
  projectId: string;
  signal: TelemetrySignal;
  rejectedCount: number;
  reason: string;
  rejectedAt: Date;
}

export interface RejectionRepository {
  addRejections(rejections: RecordedRejections): Promise<void>;
  /** Totals per signal over the hours that overlap the last `windowHours` hours. */
  readRejectedTelemetry(
    projectId: string,
    windowHours: number,
    now: Date,
  ): Promise<RejectedTelemetry>;
}

const MILLISECONDS_PER_HOUR = 3_600_000;
const MAXIMUM_STORED_REASON_LENGTH = 500;

interface RejectionCountRow {
  signal: TelemetrySignal;
  rejected_count: number | string;
  last_reason: string;
  last_rejected_at: string;
}

export function createRejectionRepository(database: TelemetryDatabase): RejectionRepository {
  return {
    async addRejections({ projectId, signal, rejectedCount, reason, rejectedAt }) {
      await database.orm.em.fork().execute(
        `insert into rejection_counts
            (project_id, signal, hour_start, rejected_count, last_reason, last_rejected_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict (project_id, signal, hour_start) do update set
            rejected_count = rejection_counts.rejected_count + excluded.rejected_count,
            last_reason = excluded.last_reason,
            last_rejected_at = excluded.last_rejected_at`,
        [
          projectId,
          signal,
          formatHourStart(rejectedAt.getTime()),
          rejectedCount,
          makeTextStorable(reason).slice(0, MAXIMUM_STORED_REASON_LENGTH),
          rejectedAt.toISOString(),
        ],
      );
    },

    async readRejectedTelemetry(projectId, windowHours, now) {
      const rows = await database.orm.em.fork().execute<RejectionCountRow[]>(
        `select signal, rejected_count, last_reason, last_rejected_at
          from rejection_counts
          where project_id = ? and hour_start >= ?`,
        [projectId, formatHourStart(now.getTime() - windowHours * MILLISECONDS_PER_HOUR)],
      );
      return {
        windowHours,
        spans: summarizeSignal(rows, "spans"),
        logs: summarizeSignal(rows, "logs"),
        metrics: summarizeSignal(rows, "metrics"),
      };
    },
  };
}

function formatHourStart(unixMilliseconds: number): string {
  const hourStart = Math.floor(unixMilliseconds / MILLISECONDS_PER_HOUR) * MILLISECONDS_PER_HOUR;
  return new Date(hourStart).toISOString();
}

function summarizeSignal(
  rows: RejectionCountRow[],
  signal: TelemetrySignal,
): RejectedTelemetrySummary {
  const signalRows = rows.filter((row) => row.signal === signal);
  const latestRow = signalRows.reduce<RejectionCountRow | null>(
    (latest, row) =>
      latest === null || row.last_rejected_at > latest.last_rejected_at ? row : latest,
    null,
  );
  return {
    rejectedCount: signalRows.reduce((total, row) => total + Number(row.rejected_count), 0),
    lastReason: latestRow?.last_reason ?? null,
    lastRejectedAt: latestRow?.last_rejected_at ?? null,
  };
}
