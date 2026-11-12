import { type Evaluator, type EvaluatorResult, needsSpans, type Span } from "@extispex/contracts";
import type { StructuredLogger } from "@extispex/service-runtime";
import {
  type GradedStep,
  type GradingDependencies,
  runGradingEvaluator,
  runRegexEvaluator,
  runTelemetryEvaluator,
} from "../evaluators/mod.ts";
import {
  executeIterationAgainstTarget,
  type ExecutionResult,
  passIterationTelemetryGate,
  type TelemetryClient,
  type TraceCompletionTiming,
} from "../iterations/mod.ts";
import type {
  EvaluateAttemptJob,
  EvaluationJob,
  ExecuteAttemptJob,
  JobQueue,
  SummarizeRunJob,
} from "../job-queue/mod.ts";
import type { ReportDeliverer } from "../reports/mod.ts";
import {
  type AttemptToEvaluate,
  type AttemptToExecute,
  type EvaluationRunRepository,
  MAXIMUM_SUMMARY_ATTEMPTS,
  type TargetRepository,
} from "../storage/mod.ts";
import type { TargetClient } from "../targets/mod.ts";
import { writeLlmSummary } from "./llm-summary.ts";
import { decideIterationOutcome } from "./run-verdicts.ts";

export const DEFAULT_REGEX_TIMEOUT_MILLISECONDS = 1_000;
/** Time since the last report, so a long run stays open while the script keeps reporting. */
export const DEFAULT_INACTIVE_RUN_TIMEOUT_MILLISECONDS = 86_400_000;

/** A job that was lost between the database and the queue is queued again after this long. */
const STALLED_EVALUATION_MILLISECONDS = 120_000;
const MAINTENANCE_INTERVAL_MILLISECONDS = 30_000;
/** Well within the two minutes after which an attempt counts as stalled. */
const EXECUTION_RENEWAL_INTERVAL_MILLISECONDS = 30_000;
/** An LLM Summary whose provider failed is tried again after this long. */
const SUMMARY_RETRY_DELAY_MILLISECONDS = 30_000;

export interface EvaluationWorkerDependencies extends GradingDependencies {
  evaluationRunRepository: EvaluationRunRepository;
  targetRepository: TargetRepository;
  targetClient: TargetClient;
  jobQueue: JobQueue;
  reportDeliverer: ReportDeliverer;
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
  /** Writes a finished run's LLM Summary. Safe to repeat. */
  summarizeRun(job: SummarizeRunJob): Promise<void>;
  /** Handles a job from the queue, whichever kind it is. */
  handleJob(job: EvaluationJob): Promise<void>;
  /**
   * Queues stalled evaluations, LLM Summaries and Report deliveries again and ends inactive runs.
   * Safe to run on every replica.
   */
  runMaintenance(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createAttemptEvaluationWorker(
  dependencies: EvaluationWorkerDependencies,
): EvaluationWorker {
  const { evaluationRunRepository, jobQueue, logger, readCurrentTime } = dependencies;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  /** The Transcript: every step of a Session Test Case, or the one input and its Output. */
  const readTranscript = (attempt: AttemptToEvaluate): GradedStep[] => {
    const { definition } = attempt;
    if (definition.scope === "trace") {
      return [{ stepNumber: 1, input: definition.input, output: attempt.output }];
    }
    return attempt.stepOutputs.map((output, stepIndex) => ({
      stepNumber: stepIndex + 1,
      input: definition.steps?.[stepIndex]?.input ?? null,
      output,
    }));
  };

  const runEvaluator = async (
    evaluator: Evaluator,
    attempt: AttemptToEvaluate,
    spans: Span[],
  ) => {
    if (evaluator.type === "telemetry") return runTelemetryEvaluator(evaluator, spans);
    if (evaluator.type === "grading") {
      return await runGradingEvaluator(evaluator, {
        projectId: attempt.projectId,
        testCaseName: attempt.testCaseName,
        expectedOutput: attempt.definition.expectedOutput,
        transcript: readTranscript(attempt),
        spans,
      }, dependencies);
    }
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
    // An LLM may take long; renewing the request keeps maintenance from queuing the job again.
    const renewalTimer = setInterval(() => {
      evaluationRunRepository.keepEvaluationWaiting(job, readCurrentTime()).catch((error) =>
        logger.error("A running evaluation could not be renewed", { error, ...job })
      );
    }, EXECUTION_RENEWAL_INTERVAL_MILLISECONDS);
    const results: EvaluatorResult[] = [];
    try {
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
    } finally {
      clearInterval(renewalTimer);
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
      if (!needsSpans(attempt.definition.evaluators)) {
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

    async summarizeRun(job) {
      const claim = await evaluationRunRepository.claimSummary(job, readCurrentTime());
      if (claim === null) return;
      if (claim.attempt > MAXIMUM_SUMMARY_ATTEMPTS) {
        await evaluationRunRepository.recordSummary(job, {
          status: "failed",
          error: `The LLM Summary could not be written in ${MAXIMUM_SUMMARY_ATTEMPTS} attempts.`,
        }, readCurrentTime());
        return;
      }
      const run = await evaluationRunRepository.readRunForSummary(job.runId);
      if (run === null) return;
      const renewalTimer = setInterval(() => {
        evaluationRunRepository.renewSummary(job, readCurrentTime()).catch((error) =>
          logger.error("The claim on an LLM Summary could not be renewed", { error, ...job })
        );
      }, EXECUTION_RENEWAL_INTERVAL_MILLISECONDS);
      try {
        const result = await writeLlmSummary(claim, run, dependencies);
        if (result.status === "completed") {
          await evaluationRunRepository.recordSummary(job, result, readCurrentTime());
          return;
        }
        if (result.isRetryable && claim.attempt < MAXIMUM_SUMMARY_ATTEMPTS) {
          logger.info("An LLM Summary will be tried again", { reason: result.error, ...job });
          await evaluationRunRepository.releaseSummary(job, readCurrentTime());
          await jobQueue.enqueue([job], { delayMilliseconds: SUMMARY_RETRY_DELAY_MILLISECONDS });
          return;
        }
        await evaluationRunRepository.recordSummary(job, {
          status: "failed",
          error: result.error,
        }, readCurrentTime());
      } finally {
        clearInterval(renewalTimer);
      }
    },

    handleJob: (job) => {
      if (job.kind === "deliver-report") return dependencies.reportDeliverer.deliverReport(job);
      if (job.kind === "execute") return worker.executeAttempt(job);
      if (job.kind === "summarize") return worker.summarizeRun(job);
      return worker.evaluateAttempt(job);
    },

    async runMaintenance() {
      const now = readCurrentTime();
      const stalledJobs = await evaluationRunRepository.claimStalledEvaluations(
        new Date(now.getTime() - STALLED_EVALUATION_MILLISECONDS),
        now,
      );
      await jobQueue.enqueue(stalledJobs);
      const stalledSummaries = await evaluationRunRepository.claimStalledSummaries(
        new Date(now.getTime() - STALLED_EVALUATION_MILLISECONDS),
        now,
      );
      await jobQueue.enqueue(stalledSummaries);
      const { endedRunCount, jobs: endedRunJobs } = await evaluationRunRepository.endInactiveRuns(
        new Date(now.getTime() - dependencies.inactiveRunTimeoutMilliseconds),
        now,
      );
      await jobQueue.enqueue(endedRunJobs);
      const requeuedDeliveries = await dependencies.reportDeliverer.requeueStalledDeliveries();
      if (
        stalledJobs.length > 0 || stalledSummaries.length > 0 || endedRunCount > 0 ||
        requeuedDeliveries > 0
      ) {
        logger.info("Maintenance changed runs", {
          requeuedEvaluations: stalledJobs.length,
          requeuedSummaries: stalledSummaries.length,
          endedRuns: endedRunCount,
          requeuedReportDeliveries: requeuedDeliveries,
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
