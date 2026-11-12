import { isPostgresDatabaseUrl } from "@extispex/service-storage";
import type { StructuredLogger } from "@extispex/service-runtime";
import type { EvaluationDatabase } from "../storage/mod.ts";
import type { JobQueue } from "./job-queue.ts";
import { createSqliteJobQueue } from "./sqlite-job-queue.ts";

/** pg-boss on PostgreSQL, loaded only there, and the SQLite table otherwise. */
export async function openJobQueue(
  databaseUrl: string,
  database: EvaluationDatabase,
  logger: StructuredLogger,
): Promise<JobQueue> {
  if (!isPostgresDatabaseUrl(databaseUrl)) return createSqliteJobQueue({ database, logger });
  const { openPgBossJobQueue } = await import("./pg-boss-job-queue.ts");
  return await openPgBossJobQueue(databaseUrl, logger);
}
