import type { LogRepository } from "../storage/mod.ts";
import { describeRejections, type RejectionRecorder } from "./rejection-recorder.ts";
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
      const errorMessage = describeRejections(rejectionReasons, "log record", "log records");
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
