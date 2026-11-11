import type { StructuredLogger } from "@extispex/service-runtime";
import type { EvaluationDatabase } from "../storage/evaluation-database.ts";
import { QueuedJobRecord } from "../storage/evaluation-entities.ts";
import {
  type AttemptJob,
  type AttemptJobHandler,
  JOB_CONCURRENCY,
  JOB_RETRY_LIMIT,
  type JobQueue,
} from "./job-queue.ts";

/** A delivered job comes back after this long, in case the process died while handling it. */
const LEASE_MILLISECONDS = 300_000;
const RETRY_DELAY_MILLISECONDS = 1_000;
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 100;

export interface SqliteJobQueueOptions {
  database: EvaluationDatabase;
  logger: StructuredLogger;
  pollIntervalMilliseconds?: number;
}

/** The job queue of the local image: a table that one process polls. */
export function createSqliteJobQueue(options: SqliteJobQueueOptions): JobQueue {
  const { database, logger } = options;
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds ??
    DEFAULT_POLL_INTERVAL_MILLISECONDS;
  let isWorking = false;
  let workerLoops: Promise<void>[] = [];

  const claimNextJob = () =>
    database.orm.em.fork().transactional(async (entityManager) => {
      const now = new Date();
      const jobRow = await entityManager.findOne(
        QueuedJobRecord,
        { availableAt: { $lte: now } },
        { orderBy: { availableAt: "asc", id: "asc" } },
      );
      if (jobRow === null) return null;
      const deliveryCount = jobRow.deliveryCount + 1;
      await entityManager.nativeUpdate(QueuedJobRecord, { id: jobRow.id }, {
        deliveryCount,
        availableAt: new Date(now.getTime() + LEASE_MILLISECONDS),
      });
      return { id: jobRow.id, payload: jobRow.payload, deliveryCount };
    });

  const settleFailedJob = async (jobId: string, deliveryCount: number) => {
    const entityManager = database.orm.em.fork();
    if (deliveryCount > JOB_RETRY_LIMIT) {
      await entityManager.nativeDelete(QueuedJobRecord, { id: jobId });
      return;
    }
    await entityManager.nativeUpdate(QueuedJobRecord, { id: jobId }, {
      availableAt: new Date(Date.now() + RETRY_DELAY_MILLISECONDS),
    });
  };

  const runWorkerLoop = async (handler: AttemptJobHandler) => {
    while (isWorking) {
      let claimedJob;
      try {
        claimedJob = await claimNextJob();
      } catch (error) {
        logger.error("The job queue could not be read", { error });
        claimedJob = null;
      }
      if (claimedJob === null) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMilliseconds));
        continue;
      }
      try {
        await handler(claimedJob.payload as unknown as AttemptJob);
        await database.orm.em.fork().nativeDelete(QueuedJobRecord, { id: claimedJob.id });
      } catch (error) {
        logger.error("A job failed", { error, deliveryCount: claimedJob.deliveryCount });
        await settleFailedJob(claimedJob.id, claimedJob.deliveryCount).catch((settleError) =>
          logger.error("A failed job could not be settled", { error: settleError })
        );
      }
    }
  };

  return {
    async enqueue(jobs, options) {
      if (jobs.length === 0) return;
      const availableAt = new Date(Date.now() + (options?.delayMilliseconds ?? 0));
      await database.orm.em.fork().insertMany(
        QueuedJobRecord,
        jobs.map((job) => ({
          id: crypto.randomUUID(),
          payload: { ...job },
          deliveryCount: 0,
          availableAt,
        })),
      );
    },
    startWorking(handler) {
      isWorking = true;
      workerLoops = Array.from({ length: JOB_CONCURRENCY }, () => runWorkerLoop(handler));
      return Promise.resolve();
    },
    async stop() {
      isWorking = false;
      await Promise.all(workerLoops);
    },
  };
}
