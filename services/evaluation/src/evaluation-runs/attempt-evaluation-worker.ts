import type { Evaluator, EvaluatorResult, Span } from "@extispex/contracts";
import type { StructuredLogger } from "@extispex/service-runtime";
import { runRegexEvaluator } from "../evaluators/regex-evaluator.ts";
import { runTelemetryEvaluator } from "../evaluators/telemetry-evaluator.ts";
import { passIterationTelemetryGate } from "../iterations/iteration-telemetry-gate.ts";
import {
  executeIterationAgainstTarget,
  type ExecutionResult,
} from "../iterations/target-execution.ts";
import type { TelemetryClient } from "../iterations/telemetry-client.ts";
import type { TraceCompletionTiming } from "../iterations/trace-completion.ts";
import type {
  AttemptJob,
  EvaluateAttemptJob,
  ExecuteAttemptJob,
  JobQueue,
} from "../job-queue/job-queue.ts";
import type {
  AttemptToEvaluate,
  AttemptToExecute,
  EvaluationRunRepository,
} from "../storage/evaluation-run-repository.ts";
import type { TargetRepository } from "../storage/target-repository.ts";
import type { TargetClient } from "../targets/target-client.ts";
import { decideIterationOutcome } from "./run-verdicts.ts";

export const DEFAULT_REGEX_TIMEOUT_MILLISECONDS = 1_000;
/** Time since the last report, so a long run stays open while the script keeps reporting. */
export const DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS = 86_400_000;

/** A job that was lost between the database and the queue is queued again after this long. */
const STALLED_EVALUATION_MILLISECONDS = 120_000;
const MAINTENANCE_INTERVAL_MILLISECONDS = 30_000;
/** Well within the two minutes after which an attempt counts as stalled. */
const EXECUTION_RENEWAL_INTERVAL_MILLISECONDS = 30_000;

export interface EvaluationWorkerDependencies {
  evaluationRunRepository: EvaluationRunRepository;
  targetRepository: TargetRepository;
  targetClient: TargetClient;
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
  /** Calls the Target for one attempt and stores what it returned. Safe to repeat. */
  executeAttempt(job: ExecuteAttemptJob): Promise<void>;
  /** Handles a job from the queue, whichever kind it is. */
  handleJob(job: AttemptJob): Promise<void>;
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

  const runEvaluator = async (
    evaluator: Evaluator,
    attempt: AttemptToEvaluate,
    spans: Span[],
  ) => {
    if (evaluator.type === "telemetry") return runTelemetryEvaluator(evaluator, spans);
    const output = evaluator.step === undefined
      ? attempt.output
      : attempt.stepOutputs[evaluator.step - 1];
    return await runRegexEvaluator(evaluator, output, dependencies.regexTimeoutMilliseconds);
  };

  const runEvaluators = async (
    job: EvaluateAttemptJob,
    attempt: AttemptToEvaluate,
    spans: Span[],
  ) => {
    const results: EvaluatorResult[] = [];
    for (const evaluator of attempt.definition.evaluators) {
      try {
        results.push(await runEvaluator(evaluator, attempt, spans));
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
    await jobQueue.enqueue(
      await evaluationRunRepository.recordEvaluation(
        job,
        decideIterationOutcome(results),
        results,
        readCurrentTime(),
      ),
    );
  };

  /** Never rejects because of the Target: whatever goes wrong there is the attempt's Error. */
  const callTarget = async (
    job: ExecuteAttemptJob,
    claim: AttemptToExecute,
  ): Promise<ExecutionResult> => {
    const endpoint = claim.targetId === null
      ? null
      : await dependencies.targetRepository.readTargetForCalling(claim.targetId);
    if (endpoint === null) {
      return { status: "error", error: "The Target of this run no longer exists.", steps: [] };
    }
    try {
      return await executeIterationAgainstTarget(
        dependencies.targetClient,
        endpoint,
        claim.definition,
      );
    } catch (error) {
      logger.error("The Target could not be called", { error, ...job });
      return { status: "error", error: "The Target could not be called.", steps: [] };
    }
  };

  const worker: EvaluationWorker = {
    async evaluateAttempt(job) {
      const attempt = await evaluationRunRepository.findAttemptToEvaluate(job);
      if (attempt === null) return;
      // Only spans can be mixed up or incomplete, so an Output alone is judged at once.
      if (!attempt.definition.evaluators.some((evaluator) => evaluator.type === "telemetry")) {
        await recordResults(job, await runEvaluators(job, attempt, []));
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
        await jobQueue.enqueue(
          await evaluationRunRepository.recordEvaluation(
            job,
            "error",
            [],
            readCurrentTime(),
            gateResult.reason,
          ),
        );
        return;
      }
      await recordResults(job, await runEvaluators(job, attempt, gateResult.spans));
    },

    async executeAttempt(job) {
      const claim = await evaluationRunRepository.claimAttemptExecution(job, readCurrentTime());
      if (claim === null) return;
      const renewalTimer = setInterval(() => {
        evaluationRunRepository.renewAttemptExecution(job, readCurrentTime()).catch((error) =>
          logger.error("The claim on an attempt could not be renewed", { error, ...job })
        );
      }, EXECUTION_RENEWAL_INTERVAL_MILLISECONDS);
      try {
        const result = await callTarget(job, claim);
        await jobQueue.enqueue(
          await evaluationRunRepository.recordExecution(job, result, readCurrentTime()),
        );
      } finally {
        clearInterval(renewalTimer);
      }
    },

    handleJob: (job) =>
      job.kind === "execute" ? worker.executeAttempt(job) : worker.evaluateAttempt(job),

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
      await jobQueue.startWorking(worker.handleJob);
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
