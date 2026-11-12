import { DEFAULT_RETENTION_DAYS } from "@extispex/contracts";
import type { ProjectLifecycleSource, StructuredLogger } from "@extispex/service-runtime";
import type { BackgroundLease } from "@extispex/service-storage";
import { OLDEST_ACCEPTED_RECORD_AGE_DAYS } from "../ingestion/mod.ts";
import type { RetentionRepository } from "../storage/mod.ts";

const NANOSECONDS_PER_DAY = 86_400_000_000_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const MILLISECONDS_PER_HOUR = 3_600_000;
/** `GET /v1/rejected-telemetry` shows the last 24 hours, so older counts are never read. */
const REJECTION_COUNT_HOURS = 24;

export interface TelemetryDataLifecycleDependencies {
  retentionRepository: RetentionRepository;
  projectLifecycle: ProjectLifecycleSource;
  lease: BackgroundLease;
  isPostgres: boolean;
  logger: StructuredLogger;
  readCurrentTime: () => Date;
}

export type TelemetryDataLifecycleOutcome =
  | { status: "skipped" }
  | { status: "ran"; removedProjectIds: string[]; droppedPartitions: string[] };

/**
 * Telemetry's periodic data work, on the replica that holds the lease:
 *
 * 1. Removes every record of each deleted Project and reports it to Identity.
 * 2. On PostgreSQL, drops the days of Log Records and metric points that are past both the longest
 *    Retention Period and the window in which ingestion still accepts records for a day, so that
 *    no replica can need a dropped partition again.
 * 3. Deletes each Project's records older than its own Retention Period. Log Records and metric
 *    points are deleted row by row only where dropping days does not cover them: on SQLite, and
 *    for Projects with a shorter period than the one that decides the drop.
 * 4. Forgets rejected counts older than the 24 hours that are shown.
 */
export function createTelemetryDataLifecycle(
  dependencies: TelemetryDataLifecycleDependencies,
): () => Promise<TelemetryDataLifecycleOutcome> {
  const { retentionRepository, projectLifecycle, logger, readCurrentTime } = dependencies;
  return async () => {
    if (!await dependencies.lease.tryAcquire(readCurrentTime())) return { status: "skipped" };
    const lifecycle = await projectLifecycle.readProjectLifecycle();
    const removedProjectIds: string[] = [];
    for (const { projectId } of lifecycle.projectsToRemove) {
      await retentionRepository.removeProjectData(projectId);
      await projectLifecycle.recordDataRemoval(projectId);
      removedProjectIds.push(projectId);
    }

    const now = readCurrentTime();
    const nowUnixNano = BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND;
    const longestRetentionDays = lifecycle.projects.reduce(
      (longest, { retentionDays }) => Math.max(longest, retentionDays),
      DEFAULT_RETENTION_DAYS,
    );
    const dropAfterDays = Math.max(longestRetentionDays, Number(OLDEST_ACCEPTED_RECORD_AGE_DAYS));
    const droppedPartitions = dependencies.isPostgres
      ? await retentionRepository.dropDaysEndingBefore(
        nowUnixNano - BigInt(dropAfterDays) * NANOSECONDS_PER_DAY,
      )
      : [];
    for (const { projectId, retentionDays } of lifecycle.projects) {
      await retentionRepository.deleteExpiredRecords({
        projectId,
        cutoffUnixNano: nowUnixNano - BigInt(retentionDays) * NANOSECONDS_PER_DAY,
        deletesDailyRecords: !dependencies.isPostgres || retentionDays < dropAfterDays,
      });
    }
    await retentionRepository.deleteRejectionCountsBefore(
      new Date(now.getTime() - REJECTION_COUNT_HOURS * MILLISECONDS_PER_HOUR),
    );
    if (removedProjectIds.length > 0 || droppedPartitions.length > 0) {
      logger.info("Removed telemetry", { removedProjectIds, droppedPartitions });
    }
    return { status: "ran", removedProjectIds, droppedPartitions };
  };
}
