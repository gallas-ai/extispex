import type { ServiceDatabase } from "./service-database.ts";

/**
 * The table that every service with periodic work creates in its own database, in a migration of
 * its own, so that one replica at a time does the work:
 *
 * ```sql
 * create table background_leases (
 *   name varchar(64) primary key,
 *   holder varchar(64) not null,
 *   expires_at_epoch_milliseconds bigint not null
 * );
 * ```
 */
export const BACKGROUND_LEASES_TABLE = "background_leases";

export interface BackgroundLease {
  /**
   * Takes or renews the lease until `now` plus its duration, and resolves to whether this holder
   * has it. Another holder's lease is taken only after it expired.
   */
  tryAcquire(now: Date): Promise<boolean>;
}

export interface BackgroundLeaseOptions {
  /** What the lease guards, such as `data-lifecycle`. */
  name: string;
  /** Who asks: one ID per running process. */
  holder: string;
  durationMilliseconds: number;
}

interface LeaseHolderRow {
  holder: string;
}

/**
 * A lease row taken by compare-and-set: one statement inserts the row, or updates it only when it
 * expired or is already this holder's. Both databases lock the row for the update, so of two
 * replicas asking at once exactly one succeeds. The same SQL runs on SQLite and PostgreSQL.
 */
export function createBackgroundLease(
  database: ServiceDatabase,
  options: BackgroundLeaseOptions,
): BackgroundLease {
  return {
    async tryAcquire(now) {
      const nowMilliseconds = now.getTime();
      const entityManager = database.orm.em.fork();
      await entityManager.execute(
        `insert into ${BACKGROUND_LEASES_TABLE} (name, holder, expires_at_epoch_milliseconds)
          values (?, ?, ?)
          on conflict (name) do update set
            holder = excluded.holder,
            expires_at_epoch_milliseconds = excluded.expires_at_epoch_milliseconds
          where ${BACKGROUND_LEASES_TABLE}.expires_at_epoch_milliseconds <= ?
            or ${BACKGROUND_LEASES_TABLE}.holder = excluded.holder`,
        [
          options.name,
          options.holder,
          nowMilliseconds + options.durationMilliseconds,
          nowMilliseconds,
        ],
      );
      const rows = await entityManager.execute<LeaseHolderRow[]>(
        `select holder from ${BACKGROUND_LEASES_TABLE} where name = ?`,
        [options.name],
      );
      return rows[0]?.holder === options.holder;
    },
  };
}
