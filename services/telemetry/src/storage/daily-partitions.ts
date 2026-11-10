import type { TelemetryDatabase } from "./telemetry-database.ts";

export const NANOSECONDS_PER_DAY = 86_400_000_000_000n;
const UNIX_NANOSECONDS_TEXT_LENGTH = 20;

/** Any 64-bit number that only this code uses, so that replicas take turns creating partitions. */
const PARTITION_ADVISORY_LOCK_KEY = 7_207_301_100_001n;
/** A partition takes a brief exclusive lock on its table; waiting long would hold up every query. */
const PARTITION_LOCK_TIMEOUT = "5s";

export interface DailyPartitions {
  /** Makes sure that a partition exists for each of these record times. */
  ensurePartitionsFor(timesUnixNano: bigint[]): Promise<void>;
}

/** The partition's UTC day as `yyyymmdd`, for its table name. */
export function formatPartitionDay(dayStartUnixNano: bigint): string {
  const dayStart = new Date(Number(dayStartUnixNano / 1_000_000n));
  return dayStart.toISOString().slice(0, 10).replaceAll("-", "");
}

function findDayStart(timeUnixNano: bigint): bigint {
  return timeUnixNano - timeUnixNano % NANOSECONDS_PER_DAY;
}

/**
 * Creates a day's partition when its first record arrives, since no scheduler exists to create it
 * in advance. SQLite has no partitions. An advisory lock makes replicas take turns, because
 * concurrent `create table if not exists` statements can still collide in PostgreSQL's catalogs.
 */
export function createDailyPartitions(
  database: TelemetryDatabase,
  tableName: string,
): DailyPartitions {
  if (database.dialect === "sqlite") {
    return { ensurePartitionsFor: () => Promise.resolve() };
  }
  const knownDayStarts = new Set<bigint>();
  return {
    async ensurePartitionsFor(timesUnixNano) {
      const dayStarts = new Set(timesUnixNano.map(findDayStart));
      for (const dayStart of dayStarts) {
        if (knownDayStarts.has(dayStart)) continue;
        await createPartition(database, tableName, dayStart);
        knownDayStarts.add(dayStart);
      }
    },
  };
}

async function createPartition(
  database: TelemetryDatabase,
  tableName: string,
  dayStart: bigint,
): Promise<void> {
  const partitionName = `${tableName}_${formatPartitionDay(dayStart)}`;
  const lowerBound = formatPartitionBound(dayStart);
  const upperBound = formatPartitionBound(dayStart + NANOSECONDS_PER_DAY);
  await database.orm.em.fork().transactional(async (entityManager) => {
    await entityManager.execute(`set local lock_timeout = '${PARTITION_LOCK_TIMEOUT}'`);
    await entityManager.execute(`select pg_advisory_xact_lock(${PARTITION_ADVISORY_LOCK_KEY})`);
    await entityManager.execute(
      `create table if not exists "${partitionName}" partition of "${tableName}"
        for values from ('${lowerBound}') to ('${upperBound}')`,
    );
  });
}

function formatPartitionBound(timeUnixNano: bigint): string {
  return timeUnixNano.toString().padStart(UNIX_NANOSECONDS_TEXT_LENGTH, "0");
}
