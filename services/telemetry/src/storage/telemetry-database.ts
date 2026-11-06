import { Migrator } from "@mikro-orm/migrations";
import type { MikroORM } from "@mikro-orm/sql";
import { Migration0001CreateSpans as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-spans.ts";
import { Migration0001CreateSpans as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-spans.ts";
import { SpanRecord } from "./span-record-entity.ts";

export type DatabaseDialect = "postgresql" | "sqlite";

export interface TelemetryDatabase {
  readonly orm: MikroORM;
  readonly dialect: DatabaseDialect;
  close(): Promise<void>;
}

export class UnsupportedDatabaseUrlError extends Error {
  override name = "UnsupportedDatabaseUrlError";
}

/** Migrations are listed explicitly, so that no file discovery is needed at runtime. */
const MIGRATIONS_BY_DIALECT = {
  postgresql: [{ name: "0001-create-spans", class: PostgresMigration0001 }],
  sqlite: [{ name: "0001-create-spans", class: SqliteMigration0001 }],
};

/**
 * Opens the Telemetry database and applies pending migrations.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export async function openTelemetryDatabase(databaseUrl: string): Promise<TelemetryDatabase> {
  const sharedOptions = {
    entities: [SpanRecord],
    extensions: [Migrator],
    migrations: { transactional: true, allOrNothing: true, silent: true, snapshot: false },
    debug: false,
  };
  let orm: MikroORM;
  let dialect: DatabaseDialect;
  if (/^postgres(ql)?:\/\//.test(databaseUrl)) {
    const { MikroORM: PostgresOrm } = await import("@mikro-orm/postgresql");
    dialect = "postgresql";
    orm = await PostgresOrm.init({
      ...sharedOptions,
      clientUrl: databaseUrl,
      migrations: { ...sharedOptions.migrations, migrationsList: MIGRATIONS_BY_DIALECT.postgresql },
    });
  } else if (databaseUrl.startsWith("sqlite:")) {
    const { MikroORM: SqliteOrm } = await import("@mikro-orm/sqlite");
    dialect = "sqlite";
    orm = await SqliteOrm.init({
      ...sharedOptions,
      dbName: databaseUrl.slice("sqlite:".length),
      migrations: { ...sharedOptions.migrations, migrationsList: MIGRATIONS_BY_DIALECT.sqlite },
    });
  } else {
    throw new UnsupportedDatabaseUrlError(
      "The database URL must start with postgresql://, postgres:// or sqlite:.",
    );
  }
  await orm.migrator.up();
  return { orm, dialect, close: () => orm.close(true) };
}
