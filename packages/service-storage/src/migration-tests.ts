import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
  type DatabaseMigrationMode,
  isPostgresDatabaseUrl,
  MissingDatabaseError,
  PendingMigrationsError,
  replacePostgresDatabaseName,
  type ServiceDatabase,
} from "./service-database.ts";
import { listTestDatabases, type TestDatabase } from "./test-databases.ts";

export interface ServiceMigrationTestSubject {
  /** The service's name, such as `prompt`, which also names its test database. */
  serviceName: string;
  openDatabase(databaseUrl: string, migrations: DatabaseMigrationMode): Promise<ServiceDatabase>;
  migrateDatabase(databaseUrl: string): Promise<string[]>;
  /** A table that the first migration creates. */
  tableName: string;
}

const CONCURRENT_REPLICA_COUNT = 5;

/**
 * Registers the tests every service runs for its migrations, on SQLite and, with
 * `TEST_POSTGRES_URL`, on PostgreSQL: the `migrate` command, a service in `check` mode before and
 * after it, and replicas that create and migrate one database at the same time.
 */
export function registerServiceMigrationTests(subject: ServiceMigrationTestSubject): void {
  for (const testDatabase of listTestDatabases(subject.serviceName)) {
    Deno.test(`${subject.serviceName} migrations and check mode (${testDatabase.label})`, async (testContext) => {
      await withEmptyDatabase(testDatabase, subject.serviceName, async (databaseUrl) => {
        await testContext.step(
          "check mode refuses a database that was never migrated",
          async () => {
            const failure = await assertRejects(() => subject.openDatabase(databaseUrl, "check"));
            assert(
              failure instanceof PendingMigrationsError || failure instanceof MissingDatabaseError,
              `Expected a refusal, got ${failure}`,
            );
          },
        );

        let allMigrationNames: string[] = [];
        await testContext.step("the migrate command applies every migration once", async () => {
          allMigrationNames = await subject.migrateDatabase(databaseUrl);
          assert(allMigrationNames.length > 0);
          assertEquals(await subject.migrateDatabase(databaseUrl), []);
        });

        await testContext.step("check mode then opens the database", async () => {
          const database = await subject.openDatabase(databaseUrl, "check");
          try {
            const [{ count }] = await database.orm.em.fork().execute(
              `select count(*) as count from ${subject.tableName}`,
            );
            assertEquals(Number(count), 0);
          } finally {
            await database.close();
          }
        });

        const lastMigrationName = allMigrationNames.at(-1)!;
        await testContext.step("check mode refuses a database behind this version", async () => {
          await executeStatements(databaseUrl, [
            `delete from mikro_orm_migrations where name = '${lastMigrationName}'`,
          ]);
          const failure = await assertRejects(() => subject.openDatabase(databaseUrl, "check"));
          assertInstanceOf(failure, PendingMigrationsError);
          assertEquals(failure.pendingMigrationNames, [lastMigrationName]);
          await executeStatements(databaseUrl, [
            `insert into mikro_orm_migrations (name, executed_at) values ('${lastMigrationName}', current_timestamp)`,
          ]);
        });

        await testContext.step(
          "check mode opens a database ahead of this version, as during an upgrade",
          async () => {
            await executeStatements(databaseUrl, [
              "insert into mikro_orm_migrations (name, executed_at) values ('9999-from-a-later-version', current_timestamp)",
            ]);
            const database = await subject.openDatabase(databaseUrl, "check");
            await database.close();
          },
        );
      });
    });
  }

  const postgresDatabase = listTestDatabases(subject.serviceName).find((testDatabase) =>
    testDatabase.label === "postgresql"
  );
  Deno.test({
    name: `${subject.serviceName}: replicas that start together create and migrate one database ` +
      "(postgresql)",
    ignore: postgresDatabase === undefined,
    fn: async () => {
      await withEmptyDatabase(postgresDatabase!, subject.serviceName, async (databaseUrl) => {
        const appliedNamesByReplica = await Promise.all(
          Array.from(
            { length: CONCURRENT_REPLICA_COUNT },
            () => subject.migrateDatabase(databaseUrl),
          ),
        );
        const replicasThatMigrated = appliedNamesByReplica.filter((names) => names.length > 0);
        assertEquals(replicasThatMigrated.length, 1);

        // Services that apply migrations at start, as in Compose, wait for each other the same way.
        const databases = await Promise.all(
          Array.from(
            { length: CONCURRENT_REPLICA_COUNT },
            () => subject.openDatabase(databaseUrl, "apply"),
          ),
        );
        await Promise.all(databases.map((database) => database.close()));
      });
    },
  });
}

/** A database that does not exist yet: a new file on SQLite, a new name on PostgreSQL. */
async function withEmptyDatabase(
  testDatabase: TestDatabase,
  serviceName: string,
  action: (databaseUrl: string) => Promise<void>,
): Promise<void> {
  const uniquePart = crypto.randomUUID().replaceAll("-", "");
  if (testDatabase.label === "sqlite") {
    const directory = await Deno.makeTempDir({ prefix: `${serviceName}-migrations-` });
    try {
      await action(`sqlite:${directory}/${serviceName}.sqlite`);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
    return;
  }
  const databaseName = `${serviceName}_migrations_${uniquePart}`;
  try {
    await action(replacePostgresDatabaseName(testDatabase.url, databaseName));
  } finally {
    const { MikroORM: PostgresOrm } = await import("@mikro-orm/postgresql");
    const administration = await PostgresOrm.init({
      clientUrl: replacePostgresDatabaseName(testDatabase.url, "postgres"),
      entities: [],
      discovery: { warnWhenNoEntities: false },
      ensureDatabase: false,
      debug: false,
    });
    await administration.em.getConnection().execute(
      `drop database if exists "${databaseName}" with (force)`,
    );
    await administration.close(true);
  }
}

/** Runs statements without opening the service's database, which would apply or check migrations. */
async function executeStatements(databaseUrl: string, statements: string[]): Promise<void> {
  const bareOptions = {
    entities: [],
    discovery: { warnWhenNoEntities: false },
    ensureDatabase: false,
    debug: false,
  };
  const orm = isPostgresDatabaseUrl(databaseUrl)
    ? await (await import("@mikro-orm/postgresql")).MikroORM.init({
      ...bareOptions,
      clientUrl: databaseUrl,
    })
    : await (await import("@mikro-orm/sqlite")).MikroORM.init({
      ...bareOptions,
      dbName: databaseUrl.slice("sqlite:".length),
    });
  try {
    for (const statement of statements) {
      await orm.em.getConnection().execute(statement);
    }
  } finally {
    await orm.close(true);
  }
}
