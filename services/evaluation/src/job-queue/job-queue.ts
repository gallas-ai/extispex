/** Asks the worker to judge one reported attempt of an Iteration. */
export interface EvaluateAttemptJob {
  kind?: "evaluate";
  iterationId: string;
  attemptNumber: number;
}

/** Asks the worker to call the Target for one attempt of an Iteration. */
export interface ExecuteAttemptJob {
  kind: "execute";
  iterationId: string;
  attemptNumber: number;
}

/** Asks the worker to write a finished run's LLM Summary. */
export interface SummarizeRunJob {
  kind: "summarize";
  runId: string;
}

export type AttemptJob = EvaluateAttemptJob | ExecuteAttemptJob;

/** Asks the worker to send one channel's Report of a finished run. */
export interface DeliverReportJob {
  kind: "deliver-report";
  deliveryId: string;
}

export type EvaluationJob = AttemptJob | DeliverReportJob | SummarizeRunJob;

export interface EnqueueOptions {
  delayMilliseconds?: number;
}

export type JobHandler = (job: EvaluationJob) => Promise<void>;

/**
 * Evaluation's private queue, with pg-boss in production and a SQLite table in the local image.
 * Delivery is at least once and a handler that rejects is retried, so handlers must be idempotent.
 */
export interface JobQueue {
  /** With `delayMilliseconds`, the jobs are not delivered before that much time has passed. */
  enqueue(jobs: EvaluationJob[], options?: EnqueueOptions): Promise<void>;
  startWorking(handler: JobHandler): Promise<void>;
  /** Stops taking jobs and waits for the running ones. */
  stop(): Promise<void>;
}

/** How many times a job is retried after its handler rejected. */
export const JOB_RETRY_LIMIT = 2;
/** How many jobs one worker process handles at once. */
export const JOB_CONCURRENCY = 4;
