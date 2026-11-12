import { readPositiveIntegerEnvironmentVariable } from "./environment-variables.ts";
import type { StructuredLogger } from "./structured-logger.ts";

/** How often each service runs its data lifecycle by default: retention and deleted Projects. */
export const DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS = 600_000;

/** `DATA_LIFECYCLE_INTERVAL_MILLISECONDS`, or ten minutes. Tests shorten it. */
export function readDataLifecycleIntervalMilliseconds(): number {
  return readPositiveIntegerEnvironmentVariable(
    "DATA_LIFECYCLE_INTERVAL_MILLISECONDS",
    DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS,
  );
}

export interface PeriodicTaskOptions {
  /** For the log, such as `data lifecycle`. */
  taskName: string;
  intervalMilliseconds: number;
  runTask: () => Promise<unknown>;
  logger: StructuredLogger;
}

export interface PeriodicTask {
  /** Stops scheduling and waits for a run in progress. */
  stop(): Promise<void>;
}

/**
 * Runs a task at once and then every interval, counted from the end of the previous run, so that
 * runs never overlap in one process. A failed run is logged and the next one comes as planned.
 * Replicas keep each other out with a lease inside the task, not here.
 */
export function startPeriodicTask(options: PeriodicTaskOptions): PeriodicTask {
  let isStopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let runningTask: Promise<void> = Promise.resolve();

  const runOnce = () => {
    timer = null;
    runningTask = options.runTask()
      .then(() => undefined)
      .catch((error) => options.logger.error(`The ${options.taskName} failed`, { error }))
      .finally(() => {
        if (!isStopped) timer = setTimeout(runOnce, options.intervalMilliseconds);
      });
  };
  timer = setTimeout(runOnce, 0);

  return {
    async stop() {
      isStopped = true;
      if (timer !== null) clearTimeout(timer);
      await runningTask;
    },
  };
}
