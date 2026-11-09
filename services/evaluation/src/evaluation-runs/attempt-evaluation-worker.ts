import type { Evaluator, EvaluatorResult, Span } from "@extispex/contracts";
import type { StructuredLogger } from "@extispex/service-runtime";
import { runRegexEvaluator } from "../evaluators/regex-evaluator.ts";
import { runTelemetryEvaluator } from "../evaluators/telemetry-evaluator.ts";
import { passIterationTelemetryGate } from "../iterations/iteration-telemetry-gate.ts";
import type { TelemetryClient } from "../iterations/telemetry-client.ts";
import type { TraceCompletionTiming } from "../iterations/trace-completion.ts";
import type { EvaluateAttemptJob, JobQueue } from "../job-queue/job-queue.ts";
import type { EvaluationRunRepository } from "../storage/evaluation-run-repository.ts";
import { decideIterationOutcome } from "./run-verdicts.ts";

export const DEFAULT_REGEX_TIMEOUT_MILLISECONDS = 1_000;
/** Time since the last report, so a long run stays open while the script keeps reporting. */
export const DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS = 86_400_000;

/** A job that was lost between the database and the queue is queued again after this long. */
const STALLED_EVALUATION_MILLISECONDS = 120_000;
const MAINTENANCE_INTERVAL_MILLISECONDS = 30_000;

export interface EvaluationWorkerDependencies {
  evaluationRunRepository: EvaluationRunRepository;
  jobQueue: JobQueue;
  telemetryClient: TelemetryClient;
  traceCompletionTiming: TraceCompletionTiming;
  logger: StructuredLogger;
  regexTimeoutMilliseconds: number;
  inactiveRunTimeoutMilliseconds: number;
  readCurrentTime: () => Date;
}

export interface EvaluationWorker {
  /** Judges one attempt and stores the result. Safe to repeat. */
  evaluateAttempt(job: EvaluateAttemptJob): Promise<void>;
  /** Queues stalled evaluations again and ends inactive runs. Safe to run on every replica. */
  runMaintenance(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createAttemptEvaluationWorker(
  dependencies: EvaluationWorkerDependencies,
): EvaluationWorker {
  const { evaluationRunRepository, jobQueue, logger, readCurrentTime } = dependencies;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  const runEvaluator = async (evaluator: Evaluator, output: string, spans: Span[]) =>
    evaluator.type === "telemetry"
      ? runTelemetryEvaluator(evaluator, spans)
      : await runRegexEvaluator(evaluator, output, dependencies.regexTimeoutMilliseconds);

  const runEvaluators = async (
    job: EvaluateAttemptJob,
    output: string,
    spans: Span[],
    evaluators: Evaluator[],
  ) => {
    const results: EvaluatorResult[] = [];
    for (const evaluator of evaluators) {
      try {
        results.push(await runEvaluator(evaluator, output, spans));
      } catch (error) {
        logger.error("An Evaluator could not run", { error, ...job });
        results.push({
          name: evaluator.name,
          type: evaluator.type,
          outcome: "error",
          reason: "The Evaluator could not run.",
        });
      }
    }
    return results;
  };

  const recordResults = async (job: EvaluateAttemptJob, results: EvaluatorResult[]) => {
    await evaluationRunRepository.recordEvaluation(
      job,
      decideIterationOutcome(results),
      results,
      readCurrentTime(),
    );
  };

  const worker: EvaluationWorker = {
    async evaluateAttempt(job) {
      const attempt = await evaluationRunRepository.findAttemptToEvaluate(job);
      if (attempt === null) return;
      const { evaluators } = attempt.definition;
      // Only spans can be mixed up or incomplete, so an Output alone is judged at once.
      if (!evaluators.some((evaluator) => evaluator.type === "telemetry")) {
        await recordResults(job, await runEvaluators(job, attempt.output, [], evaluators));
        return;
      }
      const gateResult = await passIterationTelemetryGate(
        {
          evaluationRunRepository,
          telemetryClient: dependencies.telemetryClient,
          timing: dependencies.traceCompletionTiming,
          readCurrentTime,
        },
        job,
        attempt,
      );
      if (gateResult.status === "waiting") {
        await evaluationRunRepository.keepEvaluationWaiting(job, readCurrentTime());
        await jobQueue.enqueue([job], {
          delayMilliseconds: dependencies.traceCompletionTiming.pollIntervalMilliseconds,
        });
        return;
      }
      if (gateResult.status === "error") {
        await evaluationRunRepository.recordEvaluation(
          job,
          "error",
          [],
          readCurrentTime(),
          gateResult.reason,
        );
        return;
      }
      await recordResults(
        job,
        await runEvaluators(job, attempt.output, gateResult.spans, evaluators),
      );
    },

    async runMaintenance() {
      const now = readCurrentTime();
      const stalledJobs = await evaluationRunRepository.claimStalledEvaluations(
        new Date(now.getTime() - STALLED_EVALUATION_MILLISECONDS),
        now,
      );
      await jobQueue.enqueue(stalledJobs);
      const endedRunCount = await evaluationRunRepository.endInactiveRuns(
        new Date(now.getTime() - dependencies.inactiveRunTimeoutMilliseconds),
        now,
      );
      if (stalledJobs.length > 0 || endedRunCount > 0) {
        logger.info("Maintenance changed runs", {
          requeuedEvaluations: stalledJobs.length,
          endedRuns: endedRunCount,
        });
      }
    },

    async start() {
      await jobQueue.startWorking(worker.evaluateAttempt);
      maintenanceTimer = setInterval(() => {
        worker.runMaintenance().catch((error) => logger.error("Maintenance failed", { error }));
      }, MAINTENANCE_INTERVAL_MILLISECONDS);
    },

    async stop() {
      if (maintenanceTimer !== null) clearInterval(maintenanceTimer);
      await jobQueue.stop();
    },
  };
  return worker;
}
