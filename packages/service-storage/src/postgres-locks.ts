/**
 * Runs `action` while this process holds a PostgreSQL advisory lock named `lockName` in the database
 * of `databaseUrl`. Other processes asking for the same lock wait until `action` has finished.
 *
 * The lock belongs to a transaction on a connection of its own, which stays checked out of its pool
 * until the end, so an idle pool cannot close it and release the lock early. `action` does its work
 * on other connections. Advisory locks are local to one database: two locks with the same name in
 * different databases do not wait for each other.
 */
export async function withPostgresLock<Result>(
  databaseUrl: string,
  lockName: string,
  action: () => Promise<Result>,
): Promise<Result> {
  const { MikroORM: PostgresOrm } = await import("@mikro-orm/postgresql");
  const lockOrm = await PostgresOrm.init({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    ensureDatabase: false,
    debug: false,
  });
  try {
    return await lockOrm.em.fork().transactional(async (lockEntityManager) => {
      await lockEntityManager.execute("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
        lockName,
      ]);
      return await action();
    });
  } finally {
    await lockOrm.close(true);
  }
}
