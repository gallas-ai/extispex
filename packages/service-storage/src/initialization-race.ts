import { TableExistsException, UniqueConstraintViolationException } from "@mikro-orm/core";

/**
 * PostgreSQL's `duplicate_database`, `duplicate_table` and `unique_violation`. MikroORM has no
 * exception class for the first, and its migrator creates its own table through the connection,
 * which hands on the driver's error with only its code.
 */
const POSTGRES_LOST_RACE_CODES = new Set(["42P04", "42P07", "23505"]);

/**
 * Replicas that start together race to create the database and apply the migrations. Migrations run
 * in one transaction, so the loser has changed nothing and finds the work done when it tries again.
 */
export function isLostInitializationRace(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (
      current instanceof UniqueConstraintViolationException ||
      current instanceof TableExistsException ||
      POSTGRES_LOST_RACE_CODES.has(readErrorCode(current))
    ) {
      return true;
    }
  }
  return false;
}

function readErrorCode(error: Error): string {
  const errorCode = (error as Error & { code?: unknown }).code;
  return typeof errorCode === "string" ? errorCode : "";
}
