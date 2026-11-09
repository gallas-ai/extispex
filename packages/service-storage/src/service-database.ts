import type { MigrationObject, Options } from "@mikro-orm/core";
import { Migrator } from "@mikro-orm/migrations";
import type { MikroORM } from "@mikro-orm/sql";
import { isLostInitializationRace } from "./initialization-race.ts";

export type DatabaseDialect = "postgresql" | "sqlite";

/** One service's own database, opened with its entities and migrated to the latest version. */
export interface ServiceDatabase {
  readonly orm: MikroORM;
  readonly dialect: DatabaseDialect;
  close(): Promise<void>;
}

export class UnsupportedDatabaseUrlError extends Error {
  override name = "UnsupportedDatabaseUrlError";
}

export interface ServiceDatabaseOptions {
  databaseUrl: string;
  entities: Options["entities"];
  /** Listed explicitly, so that no file discovery is needed at runtime. */
  migrationsByDialect: Record<DatabaseDialect, MigrationObject[]>;
}

/**
 * Opens a service's database and applies pending migrations. A missing PostgreSQL database is
 * created first when the user is allowed to, so each service can own a database on a shared server.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export async function openServiceDatabase(
  options: ServiceDatabaseOptions,
): Promise<ServiceDatabase> {
  for (let attemptNumber = 1;; attemptNumber++) {
    try {
      return await openAndMigrate(options);
    } catch (error) {
      if (attemptNumber >= MAXIMUM_OPEN_ATTEMPTS || !isLostInitializationRace(error)) throw error;
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, attemptNumber * OPEN_RETRY_DELAY_MILLISECONDS)
      );
    }
  }
}

const MAXIMUM_OPEN_ATTEMPTS = 8;
const OPEN_RETRY_DELAY_MILLISECONDS = 250;

async function openAndMigrate(options: ServiceDatabaseOptions): Promise<ServiceDatabase> {
  const { databaseUrl } = options;
  const sharedOptions = {
    entities: options.entities,
    extensions: [Migrator],
    migrations: { transactional: true, allOrNothing: true, silent: true, snapshot: false },
    debug: false,
  };
  let orm: MikroORM;
  let dialect: DatabaseDialect;
  if (isPostgresDatabaseUrl(databaseUrl)) {
    const { MikroORM: PostgresOrm } = await import("@mikro-orm/postgresql");
    dialect = "postgresql";
    orm = await PostgresOrm.init({
      ...sharedOptions,
      clientUrl: databaseUrl,
      migrations: {
        ...sharedOptions.migrations,
        migrationsList: options.migrationsByDialect.postgresql,
      },
    });
  } else if (databaseUrl.startsWith("sqlite:")) {
    const { MikroORM: SqliteOrm } = await import("@mikro-orm/sqlite");
    dialect = "sqlite";
    orm = await SqliteOrm.init({
      ...sharedOptions,
      dbName: databaseUrl.slice("sqlite:".length),
      migrations: {
        ...sharedOptions.migrations,
        migrationsList: options.migrationsByDialect.sqlite,
      },
    });
  } else {
    throw new UnsupportedDatabaseUrlError(
      "The database URL must start with postgresql://, postgres:// or sqlite:.",
    );
  }
  try {
    await orm.migrator.up();
  } catch (error) {
    await orm.close(true);
    throw error;
  }
  return { orm, dialect, close: () => orm.close(true) };
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
