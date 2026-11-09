import type { LogRepository } from "../storage/log-repository.ts";
import type { RejectionRecorder } from "./rejection-recorder.ts";
import { normalizeLogsRequest } from "./log-normalization.ts";
import type { LogsExportOutcome, OtlpExportLogsRequest } from "./otlp-log-types.ts";

export interface LogIngestion {
  ingestLogs(projectId: string, request: OtlpExportLogsRequest): Promise<LogsExportOutcome>;
}

export function createLogIngestion(
  logRepository: LogRepository,
  rejectionRecorder: RejectionRecorder,
  readCurrentTime: () => Date,
): LogIngestion {
  return {
    async ingestLogs(projectId, request) {
      const receivedAt = readCurrentTime();
      const { logRecords, rejectionReasons } = normalizeLogsRequest(request, receivedAt);
      if (logRecords.length > 0) {
        await logRepository.insertLogRecords(projectId, logRecords, receivedAt);
      }
      if (rejectionReasons.length === 0) {
        return { rejectedLogRecordCount: 0, errorMessage: null };
      }
      const errorMessage = describeRejections(rejectionReasons);
      await rejectionRecorder.recordRejections({
        projectId,
        signal: "logs",
        rejectedCount: rejectionReasons.length,
        reason: errorMessage,
        rejectedAt: receivedAt,
      });
      return { rejectedLogRecordCount: rejectionReasons.length, errorMessage };
    },
  };
}

/** Builds a message such as `2 log records rejected: missing required attribute correlation.id (2)`. */
function describeRejections(rejectionReasons: string[]): string {
  const countsByReason = new Map<string, number>();
  for (const reason of rejectionReasons) {
    countsByReason.set(reason, (countsByReason.get(reason) ?? 0) + 1);
  }
  const reasonDescriptions = [...countsByReason].map(([reason, count]) => `${reason} (${count})`);
  const recordWord = rejectionReasons.length === 1 ? "log record" : "log records";
  return `${rejectionReasons.length} ${recordWord} rejected: ${reasonDescriptions.join("; ")}`;
}
