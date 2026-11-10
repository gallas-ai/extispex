const NANOSECONDS_PER_DAY = 86_400_000_000_000n;

/**
 * Records outside this window around the receive time are rejected. It bounds how many daily
 * partitions a wrong clock can create, and older records would fall to retention at once.
 */
export const OLDEST_ACCEPTED_RECORD_AGE_DAYS = 30n;
export const LATEST_ACCEPTED_RECORD_DAYS_AHEAD = 1n;

/** Why a record's time is outside the accepted window, or null when it is inside. */
export function findTimeWindowRejection(
  timeUnixNano: bigint,
  receivedUnixNanoseconds: bigint,
): string | null {
  const oldestAccepted = receivedUnixNanoseconds -
    OLDEST_ACCEPTED_RECORD_AGE_DAYS * NANOSECONDS_PER_DAY;
  const latestAccepted = receivedUnixNanoseconds +
    LATEST_ACCEPTED_RECORD_DAYS_AHEAD * NANOSECONDS_PER_DAY;
  if (timeUnixNano < oldestAccepted) {
    return `time is more than ${OLDEST_ACCEPTED_RECORD_AGE_DAYS} days old`;
  }
  if (timeUnixNano > latestAccepted) {
    return `time is more than ${LATEST_ACCEPTED_RECORD_DAYS_AHEAD} day in the future`;
  }
  return null;
}
