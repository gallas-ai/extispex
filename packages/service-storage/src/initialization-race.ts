import {
  DriverException,
  TableExistsException,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";

/** PostgreSQL's `duplicate_database`, which MikroORM has no exception class for. */
const POSTGRES_DUPLICATE_DATABASE_CODE = "42P04";

/**
 * Replicas that start together race to create the database and apply the migrations. Migrations run
 * in one transaction, so the loser has changed nothing and finds the work done when it tries again.
 */
export function isLostInitializationRace(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (
      current instanceof UniqueConstraintViolationException ||
      current instanceof TableExistsException ||
      (current instanceof DriverException && current.code === POSTGRES_DUPLICATE_DATABASE_CODE)
    ) {
      return true;
    }
  }
  return false;
}
