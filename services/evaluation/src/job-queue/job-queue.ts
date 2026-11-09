/** Asks the worker to judge one reported attempt of an Iteration. */
export interface EvaluateAttemptJob {
  iterationId: string;
  attemptNumber: number;
}

export interface EnqueueOptions {
  delayMilliseconds?: number;
}

export type EvaluateAttemptHandler = (job: EvaluateAttemptJob) => Promise<void>;

/**
 * Evaluation's private queue, with pg-boss in production and a SQLite table in the local image.
 * Delivery is at least once and a handler that rejects is retried, so handlers must be idempotent.
 */
export interface JobQueue {
  /** With `delayMilliseconds`, the jobs are not delivered before that much time has passed. */
  enqueue(jobs: EvaluateAttemptJob[], options?: EnqueueOptions): Promise<void>;
  startWorking(handler: EvaluateAttemptHandler): Promise<void>;
  /** Stops taking jobs and waits for the running ones. */
  stop(): Promise<void>;
}

/** How many times a job is retried after its handler rejected. */
export const JOB_RETRY_LIMIT = 2;
/** How many jobs one worker process handles at once. */
export const JOB_CONCURRENCY = 4;
