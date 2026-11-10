import type { StructuredLogger } from "@extispex/service-runtime";
import type { RecordedRejections, RejectionRepository } from "../storage/rejection-repository.ts";

/** Builds a message such as `2 log records rejected: missing required attribute correlation.id (2)`. */
export function describeRejections(
  rejectionReasons: string[],
  singularRecordWord: string,
  pluralRecordWord: string,
): string {
  const countsByReason = new Map<string, number>();
  for (const reason of rejectionReasons) {
    countsByReason.set(reason, (countsByReason.get(reason) ?? 0) + 1);
  }
  const reasonDescriptions = [...countsByReason].map(([reason, count]) => `${reason} (${count})`);
  const recordWord = rejectionReasons.length === 1 ? singularRecordWord : pluralRecordWord;
  return `${rejectionReasons.length} ${recordWord} rejected: ${reasonDescriptions.join("; ")}`;
}

export interface RejectionRecorder {
  recordRejections(rejections: RecordedRejections): Promise<void>;
}

/**
 * Counts rejected records for the UI. A counter that cannot be written must not fail the export:
 * the accepted records are already stored and the sender still learns of the rejection.
 */
export function createRejectionRecorder(
  rejectionRepository: RejectionRepository,
  logger: StructuredLogger,
): RejectionRecorder {
  return {
    async recordRejections(rejections) {
      try {
        await rejectionRepository.addRejections(rejections);
      } catch (error) {
        logger.warn("Counting rejected telemetry failed", {
          error,
          projectId: rejections.projectId,
          signal: rejections.signal,
        });
      }
    },
  };
}
