import type { MigrationObject, Options } from "@mikro-orm/core";
import { Migrator } from "@mikro-orm/migrations";
import type { MikroORM } from "@mikro-orm/sql";
import { withPostgresLock } from "./postgres-locks.ts";

export type DatabaseDialect = "postgresql" | "sqlite";

/** One service's own database, opened with its entities. */
export interface ServiceDatabase {
  readonly orm: MikroORM;
  readonly dialect: DatabaseDialect;
  close(): Promise<void>;
}

/**
 * What a service does with its migrations when it opens its database:
 *
 * - `apply`: creates a missing PostgreSQL database and applies pending migrations. Compose, the
 *   all-in-one process and tests use it.
 * - `check`: changes nothing and refuses a database with a pending migration. The Helm chart uses
 *   it, because its migration Job applies them before the services start.
 */
export type DatabaseMigrationMode = "apply" | "check";

export class UnsupportedDatabaseUrlError extends Error {
  override name = "UnsupportedDatabaseUrlError";
}

/** A service in `check` mode found a database that the `migrate` command has not brought up to date. */
export class PendingMigrationsError extends Error {
  override name = "PendingMigrationsError";
  constructor(readonly pendingMigrationNames: string[]) {
    super(
      `The database is missing ${pendingMigrationNames.length} migration(s): ` +
        `${pendingMigrationNames.join(", ")}. Run the service's migrate command first; ` +
        "the Helm chart's migration Job does that before every install and upgrade.",
    );
  }
}

/** A service in `check` mode found no database at all. */
export class MissingDatabaseError extends Error {
  override name = "MissingDatabaseError";
}

/** The parts of a service's database that do not depend on where it is. */
export interface ServiceDatabaseDefinition {
  entities: Options["entities"];
  /** Listed explicitly, so that no file discovery is needed at runtime. */
  migrationsByDialect: Record<DatabaseDialect, MigrationObject[]>;
}

export interface ServiceDatabaseOptions extends ServiceDatabaseDefinition {
  databaseUrl: string;
  /** `apply` when not given. */
  migrations?: DatabaseMigrationMode;
}

/** The table in which MikroORM records the names of applied migrations. */
const MIGRATION_TABLE_NAME = "mikro_orm_migrations";
/** PostgreSQL's `invalid_catalog_name`: the database in the URL does not exist. */
const POSTGRES_MISSING_DATABASE_CODE = "3D000";
/** PostgreSQL's `undefined_table`. */
const POSTGRES_MISSING_TABLE_CODE = "42P01";

/**
 * Opens a service's database. In `apply` mode, a missing PostgreSQL database is created first when
 * the user is allowed to, so each service can own a database on a shared server, and pending
 * migrations are applied. Replicas that do this at the same time wait for each other on a
 * PostgreSQL advisory lock, so one of them does the work and the others find it done.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export async function openServiceDatabase(
  options: ServiceDatabaseOptions,
): Promise<ServiceDatabase> {
  if ((options.migrations ?? "apply") === "check") return await openAndCheck(options);
  const { database } = await openAndApply(options);
  return database;
}

/**
 * The `migrate` command: creates the database when it is missing and applies pending migrations,
 * then closes it. Returns the names of the migrations it applied.
 */
export async function migrateServiceDatabase(
  options: Omit<ServiceDatabaseOptions, "migrations">,
): Promise<string[]> {
  const { database, appliedMigrationNames } = await openAndApply(options);
  await database.close();
  return appliedMigrationNames;
}

interface AppliedDatabase {
  database: ServiceDatabase;
  appliedMigrationNames: string[];
}

async function openAndApply(options: ServiceDatabaseOptions): Promise<AppliedDatabase> {
  if (!isPostgresDatabaseUrl(options.databaseUrl)) {
    // Only one process opens a SQLite file: the all-in-one process or a test.
    return await applyPendingMigrations(await initializeOrm(options));
  }
  await createPostgresDatabaseIfMissing(options.databaseUrl);
  return await withPostgresLock(
    options.databaseUrl,
    MIGRATION_LOCK_NAME,
    async () => await applyPendingMigrations(await initializeOrm(options)),
  );
}

const MIGRATION_LOCK_NAME = "extispex.migrations";

async function openAndCheck(options: ServiceDatabaseOptions): Promise<ServiceDatabase> {
  let database: ServiceDatabase;
  try {
    database = await initializeOrm(options);
  } catch (error) {
    if (hasErrorCode(error, POSTGRES_MISSING_DATABASE_CODE)) {
      throw new MissingDatabaseError(
        "The database does not exist. Run the service's migrate command first; the Helm chart's " +
          "migration Job does that before every install and upgrade.",
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const pendingMigrationNames = await listPendingMigrationNames(database, options);
    if (pendingMigrationNames.length > 0) {
      throw new PendingMigrationsError(pendingMigrationNames);
    }
  } catch (error) {
    await database.close();
    throw error;
  }
  // A database with migrations this version does not know is the normal state while an upgrade
  // rolls out: the Job has migrated, and replicas of the previous version still run.
  return database;
}

/**
 * Reads the applied names directly instead of asking MikroORM's migrator, which would create its
 * table: in `check` mode the service must not change the database.
 */
async function listPendingMigrationNames(
  database: ServiceDatabase,
  options: ServiceDatabaseDefinition,
): Promise<string[]> {
  let appliedNames: Set<string>;
  try {
    const appliedRows = await database.orm.em.fork().getConnection().execute<{ name: string }[]>(
      `select name from ${MIGRATION_TABLE_NAME}`,
    );
    appliedNames = new Set(appliedRows.map((row) => row.name));
  } catch (error) {
    if (!isMissingTableError(error, database.dialect)) throw error;
    appliedNames = new Set();
  }
  return options.migrationsByDialect[database.dialect]
    .map((migration) => migration.name)
    .filter((migrationName) => !appliedNames.has(migrationName));
}

function isMissingTableError(error: unknown, dialect: DatabaseDialect): boolean {
  if (dialect === "postgresql") return hasErrorCode(error, POSTGRES_MISSING_TABLE_CODE);
  return describeErrorChain(error).includes("no such table");
}

async function initializeOrm(options: ServiceDatabaseOptions): Promise<ServiceDatabase> {
  const { databaseUrl } = options;
  const sharedOptions = {
    entities: options.entities,
    extensions: [Migrator],
    // Creating the database is done explicitly, under a lock, and only in `apply` mode.
    ensureDatabase: false,
    migrations: { transactional: true, allOrNothing: true, silent: true, snapshot: false },
    debug: false,
  };
  if (isPostgresDatabaseUrl(databaseUrl)) {
    const { MikroORM: PostgresOrm } = await import("@mikro-orm/postgresql");
    const orm = await PostgresOrm.init({
      ...sharedOptions,
      clientUrl: databaseUrl,
      migrations: {
        ...sharedOptions.migrations,
        migrationsList: options.migrationsByDialect.postgresql,
      },
    });
    // MikroORM connects lazily; this surfaces a missing database here, not at the first query.
    try {
      await orm.em.getConnection().execute("select 1");
    } catch (error) {
      await orm.close(true);
      throw error;
    }
    return { orm, dialect: "postgresql", close: () => orm.close(true) };
  }
  if (databaseUrl.startsWith("sqlite:")) {
    const { MikroORM: SqliteOrm } = await import("@mikro-orm/sqlite");
    const orm = await SqliteOrm.init({
      ...sharedOptions,
      dbName: databaseUrl.slice("sqlite:".length),
      migrations: {
        ...sharedOptions.migrations,
        migrationsList: options.migrationsByDialect.sqlite,
      },
    });
    return { orm, dialect: "sqlite", close: () => orm.close(true) };
  }
  throw new UnsupportedDatabaseUrlError(
    "The database URL must start with postgresql://, postgres:// or sqlite:.",
  );
}

async function applyPendingMigrations(database: ServiceDatabase): Promise<AppliedDatabase> {
  try {
    const appliedMigrations = await database.orm.migrator.up();
    return {
      database,
      appliedMigrationNames: appliedMigrations.map((migration) => migration.name),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

/**
 * Creates the service's database when it does not exist. Replicas that find it missing at the same
 * time take turns on a lock in the server's `postgres` database, so exactly one creates it. A
 * database that exists needs no access to `postgres`, which a managed server may not grant.
 */
async function createPostgresDatabaseIfMissing(databaseUrl: string): Promise<void> {
  if (await canConnect(databaseUrl)) return;
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  const managementUrl = replacePostgresDatabaseName(databaseUrl, "postgres");
  await withPostgresLock(managementUrl, `extispex.create-database.${databaseName}`, async () => {
    if (await canConnect(databaseUrl)) return;
    // CREATE DATABASE cannot run in the lock's transaction, so it takes a connection of its own.
    await executeOnce(managementUrl, `create database "${databaseName.replaceAll('"', '""')}"`);
  });
}

async function executeOnce(databaseUrl: string, statement: string): Promise<void> {
  const { MikroORM: PostgresOrm } = await import("@mikro-orm/postgresql");
  const orm = await PostgresOrm.init({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    ensureDatabase: false,
    debug: false,
  });
  try {
    await orm.em.getConnection().execute(statement);
  } finally {
    await orm.close(true);
  }
}

async function canConnect(databaseUrl: string): Promise<boolean> {
  const { MikroORM: PostgresOrm } = await import("@mikro-orm/postgresql");
  const orm = await PostgresOrm.init({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    ensureDatabase: false,
    debug: false,
  });
  try {
    await orm.em.getConnection().execute("select 1");
    return true;
  } catch (error) {
    if (hasErrorCode(error, POSTGRES_MISSING_DATABASE_CODE)) return false;
    throw error;
  } finally {
    await orm.close(true);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === code) return true;
  }
  return false;
}

function describeErrorChain(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  return messages.join("\n");
}

export function isPostgresDatabaseUrl(databaseUrl: string): boolean {
  return /^postgres(ql)?:\/\//.test(databaseUrl);
}

/** The same PostgreSQL server and credentials with another database, such as `prompt`. */
export function replacePostgresDatabaseName(serverUrl: string, databaseName: string): string {
  const databaseUrl = new URL(serverUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
}
