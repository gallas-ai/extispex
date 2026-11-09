import type { StructuredLogger } from "@extispex/service-runtime";
import type { RecordedRejections, RejectionRepository } from "../storage/rejection-repository.ts";

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
