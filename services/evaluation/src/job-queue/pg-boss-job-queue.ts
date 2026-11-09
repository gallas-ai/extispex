import { PgBoss } from "pg-boss";
import type { StructuredLogger } from "@extispex/service-runtime";
import {
  type EvaluateAttemptJob,
  JOB_CONCURRENCY,
  JOB_RETRY_LIMIT,
  type JobQueue,
} from "./job-queue.ts";

const QUEUE_NAME = "evaluate-attempt";
const RETRY_DELAY_SECONDS = 1;
const POLLING_INTERVAL_SECONDS = 0.5;
const JOB_EXPIRY_SECONDS = 300;

/** The job queue on the service's own PostgreSQL database, in pg-boss's own schema. */
export async function openPgBossJobQueue(
  databaseUrl: string,
  logger: StructuredLogger,
): Promise<JobQueue> {
  const boss = new PgBoss({ connectionString: databaseUrl, schedule: false });
  boss.on("error", (error) => logger.error("The job queue reported an error", { error }));
  await boss.start();
  await boss.createQueue(QUEUE_NAME, {
    retryLimit: JOB_RETRY_LIMIT,
    retryDelay: RETRY_DELAY_SECONDS,
    expireInSeconds: JOB_EXPIRY_SECONDS,
  });
  return {
    async enqueue(jobs, options) {
      if (jobs.length === 0) return;
      const startAfter = options?.delayMilliseconds === undefined
        ? undefined
        : new Date(Date.now() + options.delayMilliseconds);
      await boss.insert(QUEUE_NAME, jobs.map((job) => ({ data: job, startAfter })));
    },
    async startWorking(handler) {
      await boss.work<EvaluateAttemptJob>(
        QUEUE_NAME,
        { localConcurrency: JOB_CONCURRENCY, pollingIntervalSeconds: POLLING_INTERVAL_SECONDS },
        async ([job]) => await handler(job.data),
      );
    },
    stop: () => boss.stop({ graceful: true, timeout: 10_000 }),
  };
}
