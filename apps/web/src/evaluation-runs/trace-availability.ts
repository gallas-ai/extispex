const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The Project's Retention Period in days when telemetry reported at `reportedAt` is older than it,
 * so that its traces are gone, or null while they can still be read.
 */
export function findExpiredRetentionDays(
  reportedAt: string,
  retentionDays: number | undefined,
  nowUnixMilliseconds: number,
): number | null {
  if (retentionDays === undefined) return null;
  return Date.parse(reportedAt) + retentionDays * MILLISECONDS_PER_DAY < nowUnixMilliseconds
    ? retentionDays
    : null;
}
