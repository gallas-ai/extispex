import {
  type EvaluationRun,
  type EvaluationRunSummary,
  type EvaluationRunWork,
  type EvaluatorResult,
  type ExecutionMode,
  type IterationReport,
  type IterationResult,
  type IterationStatus,
  type ListIterationResultsResponse,
  type ListTestCaseResultsResponse,
  type LlmSummary,
  MAXIMUM_ITERATION_ATTEMPTS,
  type RejectedReport,
  type ReportedStep,
  type TestCaseDefinition,
  type TestCaseResult,
  type TranscriptStep,
  type Verdict,
} from "@extispex/contracts";
import { type InferEntity, raw } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/sql";
import { decideRunVerdict, decideTestCaseOutcome } from "../evaluation-runs/mod.ts";
import type { ExecutionResult } from "../iterations/mod.ts";
import type {
  AttemptJob,
  DeliverReportJob,
  EvaluateAttemptJob,
  EvaluationJob,
  ExecuteAttemptJob,
  SummarizeRunJob,
} from "../job-queue/mod.ts";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import {
  EvaluationRunRecord,
  IterationAttemptRecord,
  IterationAttemptStepRecord,
  IterationRecord,
  LlmProviderRecord,
  LlmSummarySettingsRecord,
  RunTestCaseRecord,
  TestCaseRecord,
} from "./evaluation-entities.ts";
import { scheduleReportDeliveries } from "./report-delivery-repository.ts";

type RunRow = InferEntity<typeof EvaluationRunRecord>;
type IterationRow = InferEntity<typeof IterationRecord>;
type AttemptRow = InferEntity<typeof IterationAttemptRecord>;
type StepRow = InferEntity<typeof IterationAttemptStepRecord>;
type RunTestCaseRow = InferEntity<typeof RunTestCaseRecord>;

/** Stays well below the bound-parameter limits of both databases. */
const STATEMENT_CHUNK_SIZE = 500;
const UNFINISHED_STATUSES: IterationStatus[] = ["awaiting_report", "executing", "evaluating"];
/** A worker that stopped renewing its claim on an attempt has died; another may take over. */
const EXECUTION_CLAIM_MILLISECONDS = 120_000;
/** A worker writing an LLM Summary renews its claim well within this time. */
const SUMMARY_CLAIM_MILLISECONDS = 120_000;
/** How many times a worker starts writing one LLM Summary before it fails. */
export const MAXIMUM_SUMMARY_ATTEMPTS = 3;
/** The results an LLM Summary sees: the first Test Cases in run order, and a few reasons each. */
const SUMMARY_TEST_CASE_LIMIT = 200;
const SUMMARY_REASON_LIMIT = 5;

export const NOT_REPORTED_ERROR = "The Iteration was not reported before the run ended.";
export const NOT_EVALUATED_ERROR = "The Iteration was not evaluated before the run ended.";
export const NOT_EXECUTED_ERROR = "The Iteration was not finished before the run ended.";

export interface NewEvaluationRun {
  projectId: string;
  datasetId: string;
  datasetName: string;
  executionMode: ExecutionMode;
  batchSize: number;
  /** Set in Server-Driven Execution. */
  target: { id: string; name: string } | null;
}

export type StartRunResult =
  | {
    status: "started";
    runId: string;
    /** Server-Driven Execution's first attempts, to be queued after the run was stored. */
    jobs: ExecuteAttemptJob[];
  }
  | { status: "no_test_cases" };

export interface ReportResult {
  rejected: RejectedReport[];
  /** Attempts with an Output, a finished run's LLM Summary and Reports, to queue after commit. */
  jobs: EvaluationJob[];
}

export interface ResultPage {
  cursor?: number;
  limit: number;
}

export interface AttemptToEvaluate {
  projectId: string;
  testCaseName: string;
  /** In a Session Test Case, the last step's Output. */
  output: string;
  /** In a Session Test Case, every step's Output in order; otherwise empty. */
  stepOutputs: string[];
  /** Always set: a report with an Output must carry one. In a Session, the last step's. */
  correlationId: string;
  /** Every Correlation ID of the attempt: one for each step of a Session Test Case. */
  correlationIds: string[];
  sessionId: string | null;
  definition: TestCaseDefinition;
  /** When the platform made this attempt available: the run's start, or the previous attempt's end. */
  startedAt: Date;
  /** When the Output was reported. */
  reportedAt: Date;
}

/** Another attempt of the same run that used one of this attempt's IDs. */
export interface TelemetryIdConflict {
  idName: "Correlation ID" | "session.id";
  testCaseName: string;
  iterationNumber: number;
  attemptNumber: number;
}

/** What the worker needs to write one run's LLM Summary. */
export interface SummaryClaim {
  projectId: string;
  /** Null when the Project's settings named no provider; the claim then fails at once. */
  providerId: string | null;
  providerName: string | null;
  prompt: { name: string; version: number } | null;
  attempt: number;
}

/** A finished run's results, as an LLM Summary describes them. */
export interface RunForSummary {
  datasetName: string;
  executionMode: ExecutionMode;
  targetName: string | null;
  verdict: Verdict;
  createdAt: Date;
  finishedAt: Date;
  totalTestCases: number;
  testCases: {
    name: string;
    outcome: Verdict;
    scope: "trace" | "session";
    passedIterations: number;
    totalIterations: number;
    /** Distinct reasons from failed and erroneous last attempts, at most a few. */
    reasons: string[];
  }[];
}

export type SummaryOutcome =
  | { status: "completed"; text: string; model: string }
  | { status: "failed"; error: string };

/** What the worker needs to call the Target for one attempt. */
export interface AttemptToExecute {
  /** Null only if the run was started without a Target, which the API does not allow. */
  targetId: string | null;
  definition: TestCaseDefinition;
}

export interface EvaluationRunRepository {
  /** Copies the Dataset's Test Cases into the run and creates its Iterations in one transaction. */
  startRun(newRun: NewEvaluationRun, startedAt: Date): Promise<StartRunResult>;
  listRuns(
    projectId: string,
    filter: { datasetName?: string; limit: number },
  ): Promise<EvaluationRunSummary[]>;
  readRun(projectId: string, runId: string): Promise<EvaluationRun | null>;
  /** Null when the run does not exist. */
  listTestCaseResults(
    projectId: string,
    runId: string,
    page: ResultPage,
  ): Promise<ListTestCaseResultsResponse | null>;
  /** Null when the run or the Test Case does not exist. */
  readTestCaseResult(
    projectId: string,
    runId: string,
    testCaseName: string,
  ): Promise<TestCaseResult | null>;
  /** Null when the run or the Test Case does not exist. */
  listIterationResults(
    projectId: string,
    runId: string,
    testCaseName: string,
    page: ResultPage,
  ): Promise<ListIterationResultsResponse | null>;
  readWork(projectId: string, runId: string): Promise<EvaluationRunWork | null>;
  /** Null when the run does not exist. */
  reportIterations(
    projectId: string,
    runId: string,
    reports: IterationReport[],
    reportedAt: Date,
  ): Promise<ReportResult | null>;
  /**
   * Null when the run does not exist; otherwise the LLM Summary and Reports to queue, if this
   * ended the run.
   */
  requestFinish(
    projectId: string,
    runId: string,
    requestedAt: Date,
  ): Promise<EvaluationJob[] | null>;
  /** Null unless the attempt is still waiting for its evaluation. */
  findAttemptToEvaluate(job: EvaluateAttemptJob): Promise<AttemptToEvaluate | null>;
  /** Does nothing when the attempt was already judged, so a repeated job is harmless. */
  recordEvaluation(
    job: EvaluateAttemptJob,
    outcome: Verdict,
    evaluatorResults: EvaluatorResult[],
    evaluatedAt: Date,
    /** Why the attempt ended as Error, when no Evaluator could say so. */
    errorMessage?: string,
  ): Promise<EvaluationJob[]>;
  /**
   * Takes the attempt for this worker. Null when it is no longer waiting to be executed, or when
   * another worker is calling the Target, so that a repeated job does not call it twice.
   */
  claimAttemptExecution(job: ExecuteAttemptJob, claimedAt: Date): Promise<AttemptToExecute | null>;
  /** The worker is still calling the Target, so its claim holds and its job is not stalled. */
  renewAttemptExecution(job: ExecuteAttemptJob, renewedAt: Date): Promise<void>;
  /**
   * Stores what the Target returned. Does nothing when the attempt is no longer being executed.
   * The result is the jobs to queue next: its evaluation, or another attempt after an Error, and
   * the Reports when this ended the run.
   */
  recordExecution(
    job: ExecuteAttemptJob,
    result: ExecutionResult,
    recordedAt: Date,
  ): Promise<EvaluationJob[]>;
  /** Finds another attempt of the run that used one of the attempt's IDs. */
  findTelemetryIdConflict(
    job: EvaluateAttemptJob,
    telemetryIds: { correlationIds: string[]; sessionId: string | null },
  ): Promise<TelemetryIdConflict | null>;
  /** The attempt is still waiting for telemetry, so its job does not count as stalled. */
  keepEvaluationWaiting(job: EvaluateAttemptJob, requestedAt: Date): Promise<void>;
  /** Attempts whose job was queued before the cutoff; their request time is set to now. */
  claimStalledEvaluations(cutoff: Date, claimedAt: Date): Promise<AttemptJob[]>;
  /** Ends runs without activity since the cutoff, with the LLM Summaries and Reports to queue. */
  endInactiveRuns(
    cutoff: Date,
    endedAt: Date,
  ): Promise<{ endedRunCount: number; jobs: EvaluationJob[] }>;
  /**
   * Takes a finished run's LLM Summary for this worker. Null when it is not waiting to be
   * written, or when another worker holds a live claim on it.
   */
  claimSummary(job: SummarizeRunJob, claimedAt: Date): Promise<SummaryClaim | null>;
  /** The worker is still writing the LLM Summary, so its claim holds. */
  renewSummary(job: SummarizeRunJob, renewedAt: Date): Promise<void>;
  /** Stores the LLM Summary or why it failed. Does nothing unless the claim is still held. */
  recordSummary(job: SummarizeRunJob, outcome: SummaryOutcome, recordedAt: Date): Promise<void>;
  /** Puts a failed attempt back, so that the next job tries again. */
  releaseSummary(job: SummarizeRunJob, releasedAt: Date): Promise<void>;
  /** Null when the run does not exist or has not finished. */
  readRunForSummary(runId: string): Promise<RunForSummary | null>;
  /** LLM Summaries whose job was queued before the cutoff; their request time is set to now. */
  claimStalledSummaries(cutoff: Date, claimedAt: Date): Promise<SummarizeRunJob[]>;
}

interface TelemetryIdConflictRow {
  correlation_id: string | null;
  attempt_number: number | string;
  iteration_number: number | string;
  test_case_name: string;
}

function chunk<Item>(items: Item[]): Item[][] {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += STATEMENT_CHUNK_SIZE) {
    chunks.push(items.slice(start, start + STATEMENT_CHUNK_SIZE));
  }
  return chunks;
}

/** Locks the run's row until commit and reads it afresh; null when it does not exist. */
async function lockRun(
  entityManager: EntityManager,
  where: { id: string; projectId?: string },
): Promise<RunRow | null> {
  const changedCount = await entityManager.nativeUpdate(EvaluationRunRecord, where, {
    revision: raw("revision + 1"),
  });
  if (changedCount === 0) return null;
  return await entityManager.findOneOrFail(EvaluationRunRecord, where, { refresh: true });
}

function canRetry(run: RunRow, attemptNumber: number): boolean {
  return run.finishRequestedAt == null && attemptNumber < MAXIMUM_ITERATION_ATTEMPTS;
}

/**
 * An attempt ended as Error: the Iteration gets another attempt or ends as `error`. In Server-Driven
 * Execution the worker makes the next attempt, so the result is its job.
 */
async function applyAttemptError(
  entityManager: EntityManager,
  run: RunRow,
  iterationId: string,
  attemptNumber: number,
  decidedAt: Date,
): Promise<ExecuteAttemptJob[]> {
  if (!canRetry(run, attemptNumber)) {
    await entityManager.nativeUpdate(IterationRecord, { id: iterationId }, {
      status: "error",
      evaluationRequestedAt: null,
      executionHeartbeatAt: null,
    });
    return [];
  }
  const nextAttemptNumber = attemptNumber + 1;
  const isServerDriven = run.executionMode === "server";
  await entityManager.nativeUpdate(IterationRecord, { id: iterationId }, {
    status: isServerDriven ? "executing" : "awaiting_report",
    currentAttempt: nextAttemptNumber,
    evaluationRequestedAt: isServerDriven ? decidedAt : null,
    executionHeartbeatAt: null,
  });
  return isServerDriven ? [{ kind: "execute", iterationId, attemptNumber: nextAttemptNumber }] : [];
}

/** Stores a Session Test Case's steps. The attempt's own row holds the last step's values. */
async function insertAttemptSteps(
  entityManager: EntityManager,
  iterationId: string,
  attemptNumber: number,
  steps: ReportedStep[],
): Promise<void> {
  if (steps.length === 0) return;
  await entityManager.insertMany(
    IterationAttemptStepRecord,
    steps.map((step, stepIndex) => ({
      iterationId,
      attemptNumber,
      stepNumber: stepIndex + 1,
      output: step.output,
      correlationId: step.correlationId,
      sessionId: step.sessionId,
    })),
  );
}

/** Why a report cannot belong to this Test Case; null when it can. */
function findReportShapeProblem(
  report: IterationReport,
  definition: TestCaseDefinition,
): string | null {
  const reportedSteps = "steps" in report ? report.steps : undefined;
  if (definition.scope === "trace") {
    return reportedSteps === undefined ? null : "This Test Case is not a Session Test Case.";
  }
  const stepCount = definition.steps?.length ?? 0;
  if (reportedSteps !== undefined) {
    if (new Set(reportedSteps.map((step) => step.sessionId)).size > 1) {
      return "Every step of a Session must carry the same sessionId.";
    }
    if (reportedSteps.length > stepCount) return `This Test Case has ${stepCount} steps.`;
  }
  if ("error" in report) return null;
  return reportedSteps?.length === stepCount
    ? null
    : `A report on this Session Test Case needs all of its ${stepCount} steps.`;
}

/**
 * Sets the verdicts once no Iteration is open. A finished run is never changed again. The run then
 * takes the Project's LLM Summary settings, and the result is the jobs of its LLM Summary and its
 * Reports, to queue after commit.
 */
async function finalizeRunIfComplete(
  entityManager: EntityManager,
  run: RunRow,
  finishedAt: Date,
): Promise<EvaluationJob[]> {
  if (run.status === "finished") return [];
  const openCount = await entityManager.count(IterationRecord, {
    runId: run.id,
    status: { $in: UNFINISHED_STATUSES },
  });
  if (openCount > 0) return [];
  const testCaseRows = await entityManager.find(RunTestCaseRecord, { runId: run.id });
  const iterationRows = await entityManager.find(
    IterationRecord,
    { runId: run.id },
    { refresh: true },
  );
  const idsByOutcome = new Map<Verdict, string[]>();
  for (const testCaseRow of testCaseRows) {
    const outcome = decideTestCaseOutcome(
      iterationRows
        .filter((iterationRow) => iterationRow.runTestCaseId === testCaseRow.id)
        .map((iterationRow) => iterationRow.status),
      testCaseRow.definition.passThreshold,
    );
    idsByOutcome.set(outcome, [...(idsByOutcome.get(outcome) ?? []), testCaseRow.id]);
  }
  for (const [outcome, testCaseIds] of idsByOutcome) {
    for (const idChunk of chunk(testCaseIds)) {
      await entityManager.nativeUpdate(RunTestCaseRecord, { id: { $in: idChunk } }, { outcome });
    }
  }
  const verdict = decideRunVerdict([...idsByOutcome.keys()]);
  const settingsRow = await entityManager.findOne(LlmSummarySettingsRecord, {
    projectId: run.projectId,
  });
  const providerRow = settingsRow?.providerId == null
    ? null
    : await entityManager.findOne(LlmProviderRecord, { id: settingsRow.providerId });
  await entityManager.nativeUpdate(EvaluationRunRecord, { id: run.id }, {
    status: "finished",
    verdict,
    finishedAt,
    summaryStatus: providerRow === null ? "not_configured" : "pending",
    summaryProviderId: providerRow?.id ?? null,
    summaryProviderName: providerRow?.name ?? null,
    summaryPromptName: settingsRow?.promptName ?? null,
    summaryPromptVersion: settingsRow?.promptVersion ?? null,
    summaryRequestedAt: providerRow === null ? null : finishedAt,
  });
  return [
    ...(providerRow === null ? [] : [{ kind: "summarize" as const, runId: run.id }]),
    ...await scheduleReportDeliveries(entityManager, run, verdict, finishedAt),
  ];
}

/** Ends every Iteration that is still waiting for its report, and optionally for its evaluation. */
async function endOpenIterations(
  entityManager: EntityManager,
  runId: string,
  statuses: IterationStatus[],
  endedAt: Date,
): Promise<void> {
  const iterationRows = await entityManager.find(
    IterationRecord,
    { runId, status: { $in: statuses } },
    { refresh: true },
  );
  const notStartedRows = iterationRows.filter((row) =>
    row.status === "awaiting_report" || row.status === "executing"
  );
  const evaluatingRows = iterationRows.filter((row) => row.status === "evaluating");
  for (const rowChunk of chunk(notStartedRows)) {
    await entityManager.insertMany(
      IterationAttemptRecord,
      rowChunk.map((iterationRow) => ({
        iterationId: iterationRow.id,
        attemptNumber: iterationRow.currentAttempt,
        outcome: "error" as const,
        output: null,
        error: iterationRow.status === "executing" ? NOT_EXECUTED_ERROR : NOT_REPORTED_ERROR,
        correlationId: null,
        sessionId: null,
        evaluatorResults: [],
        reportedAt: endedAt,
        evaluatedAt: null,
      })),
    );
  }
  for (const iterationRow of evaluatingRows) {
    await entityManager.nativeUpdate(IterationAttemptRecord, {
      iterationId: iterationRow.id,
      attemptNumber: iterationRow.currentAttempt,
    }, { outcome: "error", error: NOT_EVALUATED_ERROR, evaluatedAt: endedAt });
  }
  for (const rowChunk of chunk(iterationRows)) {
    await entityManager.nativeUpdate(
      IterationRecord,
      { id: { $in: rowChunk.map((iterationRow) => iterationRow.id) } },
      { status: "error", evaluationRequestedAt: null, executionHeartbeatAt: null },
    );
  }
}

/** The steps and the single fields that an attempt keeps for a report. */
function describeReport(report: IterationReport) {
  const steps = "steps" in report ? report.steps ?? [] : [];
  const lastStep = steps.at(-1);
  const hasOwnIds = "correlationId" in report;
  return {
    steps,
    output: "output" in report
      ? report.output
      : "error" in report
      ? null
      : lastStep?.output ?? null,
    error: "error" in report ? report.error : null,
    correlationId: (hasOwnIds ? report.correlationId : undefined) ?? lastStep?.correlationId ??
      null,
    sessionId: (hasOwnIds ? report.sessionId : undefined) ?? lastStep?.sessionId ?? null,
  };
}

function hasSameContent(
  attemptRow: AttemptRow,
  storedSteps: StepRow[],
  report: IterationReport,
): boolean {
  const described = describeReport(report);
  const isSameStep = (stored: StepRow, reported: ReportedStep) =>
    stored.output === reported.output && stored.correlationId === reported.correlationId &&
    stored.sessionId === reported.sessionId;
  return (attemptRow.output ?? null) === described.output &&
    (attemptRow.error ?? null) === described.error &&
    (attemptRow.correlationId ?? null) === described.correlationId &&
    (attemptRow.sessionId ?? null) === described.sessionId &&
    storedSteps.length === described.steps.length &&
    storedSteps.every((stored, stepIndex) => isSameStep(stored, described.steps[stepIndex]));
}

export function createEvaluationRunRepository(
  database: EvaluationDatabase,
): EvaluationRunRepository {
  return {
    async startRun(newRun, startedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const testCaseRows = await entityManager.find(
          TestCaseRecord,
          { datasetId: newRun.datasetId },
          { orderBy: { name: "asc" } },
        );
        if (testCaseRows.length === 0) return { status: "no_test_cases" as const };
        const runId = crypto.randomUUID();
        const runTestCases = testCaseRows.map((testCaseRow, position) => ({
          id: crypto.randomUUID(),
          runId,
          position,
          name: testCaseRow.name,
          definition: testCaseRow.definition,
          outcome: null,
        }));
        const isServerDriven = newRun.executionMode === "server";
        let sequence = 0;
        const iterations = runTestCases.flatMap((runTestCase) =>
          Array.from({ length: runTestCase.definition.iterations }, (_, iterationIndex) => ({
            id: crypto.randomUUID(),
            runId,
            runTestCaseId: runTestCase.id,
            sequence: sequence++,
            iterationNumber: iterationIndex + 1,
            status: isServerDriven ? "executing" as const : "awaiting_report" as const,
            currentAttempt: 1,
            evaluationRequestedAt: isServerDriven ? startedAt : null,
            executionHeartbeatAt: null,
          }))
        );
        await entityManager.insert(EvaluationRunRecord, {
          id: runId,
          projectId: newRun.projectId,
          datasetName: newRun.datasetName,
          executionMode: newRun.executionMode,
          targetId: newRun.target?.id ?? null,
          targetName: newRun.target?.name ?? null,
          status: "running",
          verdict: null,
          batchSize: newRun.batchSize,
          totalIterations: iterations.length,
          revision: 0,
          finishRequestedAt: null,
          lastActivityAt: startedAt,
          createdAt: startedAt,
          finishedAt: null,
          summaryStatus: null,
          summaryProviderId: null,
          summaryProviderName: null,
          summaryPromptName: null,
          summaryPromptVersion: null,
          summaryText: null,
          summaryError: null,
          summaryModel: null,
          summaryAttempts: 0,
          summaryRequestedAt: null,
          summaryGeneratedAt: null,
        });
        for (const rowChunk of chunk(runTestCases)) {
          await entityManager.insertMany(RunTestCaseRecord, rowChunk);
        }
        for (const rowChunk of chunk(iterations)) {
          await entityManager.insertMany(IterationRecord, rowChunk);
        }
        return {
          status: "started" as const,
          runId,
          jobs: isServerDriven
            ? iterations.map((iteration) => ({
              kind: "execute" as const,
              iterationId: iteration.id,
              attemptNumber: 1,
            }))
            : [],
        };
      });
    },

    async listRuns(projectId, { datasetName, limit }) {
      const entityManager = database.orm.em.fork();
      const runRows = await entityManager.find(
        EvaluationRunRecord,
        datasetName === undefined ? { projectId } : { projectId, datasetName },
        { orderBy: { createdAt: "desc", id: "desc" }, limit },
      );
      const summaries: EvaluationRunSummary[] = [];
      for (const runRow of runRows) {
        const openCount = runRow.status === "finished" ? 0 : await entityManager.count(
          IterationRecord,
          { runId: runRow.id, status: { $in: UNFINISHED_STATUSES } },
        );
        summaries.push(toRunSummary(runRow, runRow.totalIterations - openCount));
      }
      return summaries;
    },

    async readRun(projectId, runId) {
      const entityManager = database.orm.em.fork();
      const runRow = await entityManager.findOne(EvaluationRunRecord, { id: runId, projectId });
      if (runRow === null) return null;
      const openCount = runRow.status === "finished" ? 0 : await entityManager.count(
        IterationRecord,
        { runId, status: { $in: UNFINISHED_STATUSES } },
      );
      return {
        ...toRunSummary(runRow, runRow.totalIterations - openCount),
        llmSummary: toLlmSummary(runRow),
      };
    },

    async listTestCaseResults(projectId, runId, { cursor, limit }) {
      const entityManager = database.orm.em.fork();
      if (await entityManager.count(EvaluationRunRecord, { id: runId, projectId }) === 0) {
        return null;
      }
      // One row more than the page shows whether another page follows.
      const testCaseRows = await entityManager.find(
        RunTestCaseRecord,
        cursor === undefined ? { runId } : { runId, position: { $gt: cursor } },
        { orderBy: { position: "asc" }, limit: limit + 1 },
      );
      const pageRows = testCaseRows.slice(0, limit);
      const iterationRows = pageRows.length === 0 ? [] : await entityManager.find(
        IterationRecord,
        { runTestCaseId: { $in: pageRows.map((row) => row.id) } },
        { fields: ["runTestCaseId", "status"] },
      );
      return {
        testCases: pageRows.map((testCaseRow) =>
          toTestCaseResult(
            testCaseRow,
            iterationRows.filter((row) => row.runTestCaseId === testCaseRow.id),
          )
        ),
        nextCursor: testCaseRows.length > limit ? pageRows[pageRows.length - 1].position : null,
      };
    },

    async readTestCaseResult(projectId, runId, testCaseName) {
      const entityManager = database.orm.em.fork();
      if (await entityManager.count(EvaluationRunRecord, { id: runId, projectId }) === 0) {
        return null;
      }
      const testCaseRow = await entityManager.findOne(RunTestCaseRecord, {
        runId,
        name: testCaseName,
      });
      if (testCaseRow === null) return null;
      const iterationRows = await entityManager.find(
        IterationRecord,
        { runTestCaseId: testCaseRow.id },
        { fields: ["runTestCaseId", "status"] },
      );
      return toTestCaseResult(testCaseRow, iterationRows);
    },

    async listIterationResults(projectId, runId, testCaseName, { cursor, limit }) {
      const entityManager = database.orm.em.fork();
      if (await entityManager.count(EvaluationRunRecord, { id: runId, projectId }) === 0) {
        return null;
      }
      const testCaseRow = await entityManager.findOne(RunTestCaseRecord, {
        runId,
        name: testCaseName,
      });
      if (testCaseRow === null) return null;
      const iterationRows = await entityManager.find(
        IterationRecord,
        cursor === undefined
          ? { runTestCaseId: testCaseRow.id }
          : { runTestCaseId: testCaseRow.id, iterationNumber: { $gt: cursor } },
        { orderBy: { iterationNumber: "asc" }, limit: limit + 1 },
      );
      const pageRows = iterationRows.slice(0, limit);
      const pageIterationIds = pageRows.map((row) => row.id);
      const attemptRows = pageRows.length === 0 ? [] : await entityManager.find(
        IterationAttemptRecord,
        { iterationId: { $in: pageIterationIds } },
        { orderBy: { attemptNumber: "asc" } },
      );
      const stepRows = pageRows.length === 0 ? [] : await entityManager.find(
        IterationAttemptStepRecord,
        { iterationId: { $in: pageIterationIds } },
        { orderBy: { stepNumber: "asc" } },
      );
      return {
        iterations: pageRows.map((iterationRow) =>
          toIterationResult(iterationRow, attemptRows, stepRows, testCaseRow.definition)
        ),
        nextCursor: iterationRows.length > limit
          ? pageRows[pageRows.length - 1].iterationNumber
          : null,
      };
    },

    async readWork(projectId, runId) {
      const entityManager = database.orm.em.fork();
      const runRow = await entityManager.findOne(EvaluationRunRecord, { id: runId, projectId });
      if (runRow === null) return null;
      const iterationRows = await entityManager.find(
        IterationRecord,
        { runId, status: "awaiting_report" },
        { orderBy: { sequence: "asc" }, limit: runRow.batchSize },
      );
      const testCaseRows = iterationRows.length === 0
        ? []
        : await entityManager.find(RunTestCaseRecord, {
          id: { $in: [...new Set(iterationRows.map((row) => row.runTestCaseId))] },
        });
      const definitions = new Map(testCaseRows.map((row) => [row.id, row]));
      return {
        runId,
        status: runRow.status as EvaluationRunWork["status"],
        verdict: runRow.verdict ?? null,
        items: iterationRows.map((iterationRow) => {
          const testCaseRow = definitions.get(iterationRow.runTestCaseId)!;
          return {
            iterationId: iterationRow.id,
            attempt: iterationRow.currentAttempt,
            testCaseName: testCaseRow.name,
            iterationNumber: iterationRow.iterationNumber,
            scope: testCaseRow.definition.scope,
            input: testCaseRow.definition.input ?? null,
            steps: testCaseRow.definition.steps ?? null,
            expectedOutput: testCaseRow.definition.expectedOutput,
          };
        }),
        evaluationsInProgress: await entityManager.count(IterationRecord, {
          runId,
          status: { $in: ["executing", "evaluating"] },
        }),
      };
    },

    async reportIterations(projectId, runId, reports, reportedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const runRow = await lockRun(entityManager, { id: runId, projectId });
        if (runRow === null) return null;
        await entityManager.nativeUpdate(EvaluationRunRecord, { id: runId }, {
          lastActivityAt: reportedAt,
        });
        const iterationIds = [...new Set(reports.map((report) => report.iterationId))];
        const iterationRows = await entityManager.find(IterationRecord, {
          runId,
          id: { $in: iterationIds },
        }, { refresh: true });
        const attemptRows = await entityManager.find(IterationAttemptRecord, {
          iterationId: { $in: iterationRows.map((iterationRow) => iterationRow.id) },
        }, { refresh: true });
        const stepRows = await entityManager.find(IterationAttemptStepRecord, {
          iterationId: { $in: iterationRows.map((iterationRow) => iterationRow.id) },
        }, { refresh: true, orderBy: { stepNumber: "asc" } });
        const testCaseRows = await entityManager.find(RunTestCaseRecord, {
          id: { $in: [...new Set(iterationRows.map((row) => row.runTestCaseId))] },
        });
        const testCasesById = new Map(testCaseRows.map((row) => [row.id, row]));
        const iterationsById = new Map(iterationRows.map((row) => [row.id, row]));
        const attemptKey = (iterationId: string, attemptNumber: number) =>
          `${iterationId}:${attemptNumber}`;
        const knownAttempts = new Map(
          attemptRows.map((row) => [attemptKey(row.iterationId, row.attemptNumber), row]),
        );
        const hasRunEnded = runRow.status === "finished" || runRow.finishRequestedAt != null;
        const rejected: RejectedReport[] = [];
        const jobs: EvaluationJob[] = [];
        for (const report of reports) {
          const reject = (code: RejectedReport["code"], message: string) =>
            rejected.push({
              iterationId: report.iterationId,
              attempt: report.attempt,
              code,
              message,
            });
          const iterationRow = iterationsById.get(report.iterationId);
          if (iterationRow === undefined) {
            reject("unknown_iteration", "This run has no such Iteration.");
            continue;
          }
          if (runRow.executionMode === "server") {
            reject("server_driven_run", "The worker runs this Evaluation Run's Iterations itself.");
            continue;
          }
          const definition = testCasesById.get(iterationRow.runTestCaseId)!.definition;
          const shapeProblem = findReportShapeProblem(report, definition);
          if (shapeProblem !== null) {
            reject("invalid_report", shapeProblem);
            continue;
          }
          const key = attemptKey(report.iterationId, report.attempt);
          const knownAttempt = knownAttempts.get(key);
          if (knownAttempt !== undefined) {
            const storedSteps = stepRows.filter((row) =>
              row.iterationId === report.iterationId && row.attemptNumber === report.attempt
            );
            if (!hasSameContent(knownAttempt, storedSteps, report)) {
              // After the run's end, the stored attempt may be the Error that ended it.
              if (hasRunEnded) reject("run_ended", "The run no longer accepts reports.");
              else reject("conflicting_report", "This attempt was already reported differently.");
            }
            continue;
          }
          if (hasRunEnded) {
            reject("run_ended", "The run no longer accepts reports.");
            continue;
          }
          if (
            iterationRow.status !== "awaiting_report" ||
            iterationRow.currentAttempt !== report.attempt
          ) {
            reject("stale_attempt", `The current attempt is ${iterationRow.currentAttempt}.`);
            continue;
          }
          const described = describeReport(report);
          const attemptRow = {
            iterationId: report.iterationId,
            attemptNumber: report.attempt,
            outcome: "error" in report ? "error" as const : null,
            output: described.output,
            error: described.error,
            correlationId: described.correlationId,
            sessionId: described.sessionId,
            evaluatorResults: [],
            reportedAt,
            evaluatedAt: null,
          };
          await entityManager.insert(IterationAttemptRecord, attemptRow);
          await insertAttemptSteps(
            entityManager,
            report.iterationId,
            report.attempt,
            described.steps,
          );
          knownAttempts.set(key, attemptRow as unknown as AttemptRow);
          if ("error" in report) {
            await applyAttemptError(
              entityManager,
              runRow,
              report.iterationId,
              report.attempt,
              reportedAt,
            );
          } else {
            await entityManager.nativeUpdate(IterationRecord, { id: report.iterationId }, {
              status: "evaluating",
              evaluationRequestedAt: reportedAt,
            });
            jobs.push({ iterationId: report.iterationId, attemptNumber: report.attempt });
          }
        }
        jobs.push(...await finalizeRunIfComplete(entityManager, runRow, reportedAt));
        return { rejected, jobs };
      });
    },

    async requestFinish(projectId, runId, requestedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const runRow = await lockRun(entityManager, { id: runId, projectId });
        if (runRow === null) return null;
        if (runRow.status === "finished") return [];
        await entityManager.nativeUpdate(EvaluationRunRecord, { id: runId }, {
          finishRequestedAt: runRow.finishRequestedAt ?? requestedAt,
        });
        await endOpenIterations(
          entityManager,
          runId,
          ["awaiting_report", "executing"],
          requestedAt,
        );
        return await finalizeRunIfComplete(entityManager, runRow, requestedAt);
      });
    },

    async findAttemptToEvaluate(job) {
      const entityManager = database.orm.em.fork();
      const iterationRow = await entityManager.findOne(IterationRecord, {
        id: job.iterationId,
        status: "evaluating",
        currentAttempt: job.attemptNumber,
      });
      if (iterationRow === null) return null;
      const attemptRow = await entityManager.findOneOrFail(IterationAttemptRecord, {
        iterationId: job.iterationId,
        attemptNumber: job.attemptNumber,
      });
      const testCaseRow = await entityManager.findOneOrFail(RunTestCaseRecord, {
        id: iterationRow.runTestCaseId,
      });
      const runRow = await entityManager.findOneOrFail(EvaluationRunRecord, {
        id: iterationRow.runId,
      });
      const previousAttempt = job.attemptNumber === 1
        ? null
        : await entityManager.findOne(IterationAttemptRecord, {
          iterationId: job.iterationId,
          attemptNumber: job.attemptNumber - 1,
        });
      const stepRows = await entityManager.find(IterationAttemptStepRecord, {
        iterationId: job.iterationId,
        attemptNumber: job.attemptNumber,
      }, { orderBy: { stepNumber: "asc" } });
      const correlationId = attemptRow.correlationId ?? "";
      return {
        projectId: runRow.projectId,
        testCaseName: testCaseRow.name,
        output: attemptRow.output ?? "",
        stepOutputs: stepRows.map((row) => row.output),
        correlationId,
        correlationIds: stepRows.length === 0
          ? [correlationId]
          : [...new Set(stepRows.map((row) => row.correlationId))],
        sessionId: attemptRow.sessionId ?? null,
        definition: testCaseRow.definition,
        startedAt: previousAttempt === null
          ? runRow.createdAt
          : previousAttempt.evaluatedAt ?? previousAttempt.reportedAt,
        reportedAt: attemptRow.reportedAt,
      };
    },

    async findTelemetryIdConflict(job, { correlationIds, sessionId }) {
      const correlationPlaceholders = correlationIds.map(() => "?").join(", ");
      const idCondition = sessionId === null
        ? `used.correlation_id in (${correlationPlaceholders})`
        : `(used.correlation_id in (${correlationPlaceholders}) or used.session_id = ?)`;
      // An attempt's own row holds only the last step's IDs, so the steps are searched as well.
      const rows = await database.orm.em.fork().execute<TelemetryIdConflictRow[]>(
        `select used.correlation_id, used.attempt_number, iteration.iteration_number,
            test_case.name as test_case_name
          from (
            select iteration_id, attempt_number, correlation_id, session_id
              from iteration_attempts
            union all
            select iteration_id, attempt_number, correlation_id, session_id
              from iteration_attempt_steps
          ) used
          join iterations iteration on iteration.id = used.iteration_id
          join run_test_cases test_case on test_case.id = iteration.run_test_case_id
          where iteration.run_id = (select run_id from iterations where id = ?)
            and ${idCondition}
            and not (used.iteration_id = ? and used.attempt_number = ?)
          limit 1`,
        [
          job.iterationId,
          ...correlationIds,
          ...(sessionId === null ? [] : [sessionId]),
          job.iterationId,
          job.attemptNumber,
        ],
      );
      if (rows.length === 0) return null;
      return {
        idName: correlationIds.includes(rows[0].correlation_id ?? "")
          ? "Correlation ID"
          : "session.id",
        testCaseName: rows[0].test_case_name,
        iterationNumber: Number(rows[0].iteration_number),
        attemptNumber: Number(rows[0].attempt_number),
      };
    },

    async keepEvaluationWaiting(job, requestedAt) {
      await database.orm.em.fork().nativeUpdate(IterationRecord, {
        id: job.iterationId,
        status: "evaluating",
        currentAttempt: job.attemptNumber,
      }, { evaluationRequestedAt: requestedAt });
    },

    async recordEvaluation(job, outcome, evaluatorResults, evaluatedAt, errorMessage) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const unlockedRow = await entityManager.findOne(IterationRecord, { id: job.iterationId });
        if (unlockedRow === null) return [];
        const runRow = await lockRun(entityManager, { id: unlockedRow.runId });
        if (runRow === null) return [];
        // Read again under the lock: another delivery of this job may have got here first.
        const iterationRow = await entityManager.findOneOrFail(
          IterationRecord,
          { id: job.iterationId },
          { refresh: true },
        );
        if (
          iterationRow.status !== "evaluating" || iterationRow.currentAttempt !== job.attemptNumber
        ) {
          return [];
        }
        await entityManager.nativeUpdate(IterationAttemptRecord, {
          iterationId: job.iterationId,
          attemptNumber: job.attemptNumber,
        }, {
          outcome,
          evaluatorResults,
          evaluatedAt,
          ...(errorMessage === undefined ? {} : { error: errorMessage }),
        });
        let nextJobs: EvaluationJob[] = [];
        if (outcome === "error") {
          nextJobs = await applyAttemptError(
            entityManager,
            runRow,
            job.iterationId,
            job.attemptNumber,
            evaluatedAt,
          );
        } else {
          await entityManager.nativeUpdate(IterationRecord, { id: job.iterationId }, {
            status: outcome,
            evaluationRequestedAt: null,
          });
        }
        return [
          ...nextJobs,
          ...await finalizeRunIfComplete(entityManager, runRow, evaluatedAt),
        ];
      });
    },

    async claimAttemptExecution(job, claimedAt) {
      const entityManager = database.orm.em.fork();
      const claimExpiresBefore = new Date(claimedAt.getTime() - EXECUTION_CLAIM_MILLISECONDS);
      // One statement, so that of two deliveries at once only one changes the row.
      const claimedCount = await entityManager.nativeUpdate(IterationRecord, {
        id: job.iterationId,
        status: "executing",
        currentAttempt: job.attemptNumber,
        $or: [
          { executionHeartbeatAt: null },
          { executionHeartbeatAt: { $lt: claimExpiresBefore } },
        ],
      }, { executionHeartbeatAt: claimedAt, evaluationRequestedAt: claimedAt });
      if (claimedCount === 0) return null;
      const iterationRow = await entityManager.findOneOrFail(IterationRecord, {
        id: job.iterationId,
      });
      const testCaseRow = await entityManager.findOneOrFail(RunTestCaseRecord, {
        id: iterationRow.runTestCaseId,
      });
      const runRow = await entityManager.findOneOrFail(EvaluationRunRecord, {
        id: iterationRow.runId,
      });
      return { targetId: runRow.targetId ?? null, definition: testCaseRow.definition };
    },

    async renewAttemptExecution(job, renewedAt) {
      await database.orm.em.fork().nativeUpdate(IterationRecord, {
        id: job.iterationId,
        status: "executing",
        currentAttempt: job.attemptNumber,
      }, { executionHeartbeatAt: renewedAt, evaluationRequestedAt: renewedAt });
    },

    async recordExecution(job, result, recordedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const unlockedRow = await entityManager.findOne(IterationRecord, { id: job.iterationId });
        if (unlockedRow === null) return [];
        const runRow = await lockRun(entityManager, { id: unlockedRow.runId });
        if (runRow === null) return [];
        const iterationRow = await entityManager.findOneOrFail(
          IterationRecord,
          { id: job.iterationId },
          { refresh: true },
        );
        if (
          iterationRow.status !== "executing" || iterationRow.currentAttempt !== job.attemptNumber
        ) {
          return [];
        }
        await entityManager.nativeUpdate(EvaluationRunRecord, { id: runRow.id }, {
          lastActivityAt: recordedAt,
        });
        const steps = result.status === "output" ? [] : result.steps;
        const lastStep = steps.at(-1);
        await entityManager.insert(IterationAttemptRecord, {
          iterationId: job.iterationId,
          attemptNumber: job.attemptNumber,
          outcome: result.status === "error" ? "error" as const : null,
          output: result.status === "output"
            ? result.output
            : result.status === "session_output"
            ? lastStep?.output ?? null
            : null,
          error: result.status === "error" ? result.error : null,
          correlationId: result.status === "output"
            ? result.correlationId
            : lastStep?.correlationId ?? null,
          sessionId: result.status === "output" ? result.sessionId : lastStep?.sessionId ?? null,
          evaluatorResults: [],
          reportedAt: recordedAt,
          evaluatedAt: null,
        });
        await insertAttemptSteps(entityManager, job.iterationId, job.attemptNumber, steps);
        let nextJobs: EvaluationJob[];
        if (result.status === "error") {
          nextJobs = await applyAttemptError(
            entityManager,
            runRow,
            job.iterationId,
            job.attemptNumber,
            recordedAt,
          );
        } else {
          await entityManager.nativeUpdate(IterationRecord, { id: job.iterationId }, {
            status: "evaluating",
            evaluationRequestedAt: recordedAt,
            executionHeartbeatAt: null,
          });
          nextJobs = [{ iterationId: job.iterationId, attemptNumber: job.attemptNumber }];
        }
        return [
          ...nextJobs,
          ...await finalizeRunIfComplete(entityManager, runRow, recordedAt),
        ];
      });
    },

    async claimStalledEvaluations(cutoff, claimedAt) {
      const entityManager = database.orm.em.fork();
      const iterationRows = await entityManager.find(IterationRecord, {
        status: { $in: ["evaluating", "executing"] },
        evaluationRequestedAt: { $lt: cutoff },
      }, { limit: STATEMENT_CHUNK_SIZE });
      if (iterationRows.length === 0) return [];
      await entityManager.nativeUpdate(IterationRecord, {
        id: { $in: iterationRows.map((iterationRow) => iterationRow.id) },
        status: { $in: ["evaluating", "executing"] },
      }, { evaluationRequestedAt: claimedAt });
      return iterationRows.map((iterationRow): EvaluationJob => ({
        ...(iterationRow.status === "executing" ? { kind: "execute" } : {}),
        iterationId: iterationRow.id,
        attemptNumber: iterationRow.currentAttempt,
      }));
    },

    async endInactiveRuns(cutoff, endedAt) {
      const inactiveRows = await database.orm.em.fork().find(EvaluationRunRecord, {
        status: "running",
        lastActivityAt: { $lt: cutoff },
      }, { limit: STATEMENT_CHUNK_SIZE });
      let endedRunCount = 0;
      const jobs: EvaluationJob[] = [];
      for (const inactiveRow of inactiveRows) {
        const endedRunJobs = await database.orm.em.fork().transactional(async (entityManager) => {
          const runRow = await lockRun(entityManager, { id: inactiveRow.id });
          // A report may have arrived since the search above.
          if (runRow === null || runRow.status === "finished" || runRow.lastActivityAt >= cutoff) {
            return null;
          }
          await endOpenIterations(entityManager, runRow.id, UNFINISHED_STATUSES, endedAt);
          return await finalizeRunIfComplete(entityManager, runRow, endedAt);
        });
        if (endedRunJobs === null) continue;
        endedRunCount++;
        jobs.push(...endedRunJobs);
      }
      return { endedRunCount, jobs };
    },

    async claimSummary(job, claimedAt) {
      const entityManager = database.orm.em.fork();
      const claimExpiresBefore = new Date(claimedAt.getTime() - SUMMARY_CLAIM_MILLISECONDS);
      // One statement, so that of two deliveries at once only one changes the row.
      const claimedCount = await entityManager.nativeUpdate(EvaluationRunRecord, {
        id: job.runId,
        $or: [
          { summaryStatus: "pending" },
          { summaryStatus: "generating", summaryRequestedAt: { $lt: claimExpiresBefore } },
        ],
      }, {
        summaryStatus: "generating",
        summaryAttempts: raw("summary_attempts + 1"),
        summaryRequestedAt: claimedAt,
      });
      if (claimedCount === 0) return null;
      const runRow = await entityManager.findOneOrFail(EvaluationRunRecord, { id: job.runId }, {
        refresh: true,
      });
      return {
        projectId: runRow.projectId,
        providerId: runRow.summaryProviderId ?? null,
        providerName: runRow.summaryProviderName ?? null,
        prompt: runRow.summaryPromptName == null || runRow.summaryPromptVersion == null
          ? null
          : { name: runRow.summaryPromptName, version: runRow.summaryPromptVersion },
        attempt: runRow.summaryAttempts,
      };
    },

    async renewSummary(job, renewedAt) {
      await database.orm.em.fork().nativeUpdate(EvaluationRunRecord, {
        id: job.runId,
        summaryStatus: "generating",
      }, { summaryRequestedAt: renewedAt });
    },

    async recordSummary(job, outcome, recordedAt) {
      await database.orm.em.fork().nativeUpdate(
        EvaluationRunRecord,
        {
          id: job.runId,
          summaryStatus: "generating",
        },
        outcome.status === "completed"
          ? {
            summaryStatus: "completed",
            summaryText: outcome.text,
            summaryModel: outcome.model,
            summaryError: null,
            summaryRequestedAt: null,
            summaryGeneratedAt: recordedAt,
          }
          : {
            summaryStatus: "failed",
            summaryError: outcome.error,
            summaryRequestedAt: null,
            summaryGeneratedAt: recordedAt,
          },
      );
    },

    async releaseSummary(job, releasedAt) {
      await database.orm.em.fork().nativeUpdate(EvaluationRunRecord, {
        id: job.runId,
        summaryStatus: "generating",
      }, { summaryStatus: "pending", summaryRequestedAt: releasedAt });
    },

    async readRunForSummary(runId) {
      const entityManager = database.orm.em.fork();
      const runRow = await entityManager.findOne(EvaluationRunRecord, {
        id: runId,
        status: "finished",
      });
      if (runRow === null || runRow.verdict == null || runRow.finishedAt == null) return null;
      const totalTestCases = await entityManager.count(RunTestCaseRecord, { runId });
      const testCaseRows = await entityManager.find(
        RunTestCaseRecord,
        { runId },
        { orderBy: { position: "asc" }, limit: SUMMARY_TEST_CASE_LIMIT },
      );
      const iterationRows = testCaseRows.length === 0 ? [] : await entityManager.find(
        IterationRecord,
        { runTestCaseId: { $in: testCaseRows.map((row) => row.id) } },
      );
      // The last attempt of each Iteration that did not pass says why.
      const unsuccessfulRows = iterationRows.filter((row) => row.status !== "passed");
      const attemptRows: AttemptRow[] = [];
      for (const rowChunk of chunk(unsuccessfulRows)) {
        attemptRows.push(
          ...await entityManager.find(IterationAttemptRecord, {
            $or: rowChunk.map((row) => ({
              iterationId: row.id,
              attemptNumber: row.currentAttempt,
            })),
          }),
        );
      }
      return {
        datasetName: runRow.datasetName,
        executionMode: runRow.executionMode as ExecutionMode,
        targetName: runRow.targetName ?? null,
        verdict: runRow.verdict,
        createdAt: runRow.createdAt,
        finishedAt: runRow.finishedAt,
        totalTestCases,
        testCases: testCaseRows.map((testCaseRow) => {
          const ownIterations = iterationRows.filter((row) => row.runTestCaseId === testCaseRow.id);
          const ownIterationIds = new Set(ownIterations.map((row) => row.id));
          const reasons = new Set<string>();
          for (const attemptRow of attemptRows) {
            if (!ownIterationIds.has(attemptRow.iterationId)) continue;
            if (attemptRow.error) reasons.add(`Error: ${attemptRow.error}`);
            for (const result of attemptRow.evaluatorResults) {
              if (result.outcome !== "passed") {
                reasons.add(`${result.name} (${result.outcome}): ${result.reason}`);
              }
            }
          }
          return {
            name: testCaseRow.name,
            outcome: testCaseRow.outcome ?? "error",
            scope: testCaseRow.definition.scope,
            passedIterations: ownIterations.filter((row) => row.status === "passed").length,
            totalIterations: ownIterations.length,
            reasons: [...reasons].slice(0, SUMMARY_REASON_LIMIT),
          };
        }),
      };
    },

    async claimStalledSummaries(cutoff, claimedAt) {
      const entityManager = database.orm.em.fork();
      const runRows = await entityManager.find(EvaluationRunRecord, {
        summaryStatus: { $in: ["pending", "generating"] },
        summaryRequestedAt: { $lt: cutoff },
      }, { fields: ["id"], limit: STATEMENT_CHUNK_SIZE });
      if (runRows.length === 0) return [];
      await entityManager.nativeUpdate(EvaluationRunRecord, {
        id: { $in: runRows.map((runRow) => runRow.id) },
        summaryStatus: "pending",
      }, { summaryRequestedAt: claimedAt });
      return runRows.map((runRow) => ({ kind: "summarize" as const, runId: runRow.id }));
    },
  };
}

function toRunSummary(runRow: RunRow, completedIterations: number): EvaluationRunSummary {
  return {
    id: runRow.id,
    datasetName: runRow.datasetName,
    executionMode: runRow.executionMode as ExecutionMode,
    targetName: runRow.targetName ?? null,
    status: runRow.status as EvaluationRunSummary["status"],
    verdict: runRow.verdict ?? null,
    totalIterations: runRow.totalIterations,
    completedIterations,
    createdAt: runRow.createdAt.toISOString(),
    finishedAt: runRow.finishedAt?.toISOString() ?? null,
  };
}

/** `generating` is the worker's claim; to a reader the LLM Summary is still pending. */
function toLlmSummary(runRow: RunRow): LlmSummary | null {
  if (runRow.summaryStatus == null) return null;
  return {
    status: runRow.summaryStatus === "generating"
      ? "pending"
      : runRow.summaryStatus as LlmSummary["status"],
    text: runRow.summaryText ?? null,
    error: runRow.summaryError ?? null,
    providerName: runRow.summaryProviderName ?? null,
    model: runRow.summaryModel ?? null,
    prompt: runRow.summaryPromptName == null || runRow.summaryPromptVersion == null
      ? null
      : { name: runRow.summaryPromptName, version: runRow.summaryPromptVersion },
    generatedAt: runRow.summaryGeneratedAt?.toISOString() ?? null,
  };
}

function toTestCaseResult(
  testCaseRow: RunTestCaseRow,
  iterationRows: Pick<IterationRow, "status">[],
): TestCaseResult {
  const { scope, input, steps, expectedOutput, evaluators, passThreshold } = testCaseRow.definition;
  return {
    name: testCaseRow.name,
    outcome: testCaseRow.outcome ?? null,
    scope,
    input: input ?? null,
    steps: steps ?? null,
    expectedOutput,
    evaluators,
    passThreshold,
    passedIterations: iterationRows.filter((row) => row.status === "passed").length,
    totalIterations: iterationRows.length,
  };
}

function toTranscript(
  iterationId: string,
  attemptNumber: number,
  stepRows: StepRow[],
  definition: TestCaseDefinition,
): TranscriptStep[] | null {
  if (definition.scope !== "session") return null;
  return stepRows
    .filter((row) => row.iterationId === iterationId && row.attemptNumber === attemptNumber)
    .map((row) => ({
      stepNumber: row.stepNumber,
      input: definition.steps?.[row.stepNumber - 1]?.input ?? null,
      output: row.output,
      correlationId: row.correlationId,
      sessionId: row.sessionId,
    }));
}

function toIterationResult(
  iterationRow: IterationRow,
  attemptRows: AttemptRow[],
  stepRows: StepRow[],
  definition: TestCaseDefinition,
): IterationResult {
  return {
    iterationId: iterationRow.id,
    iterationNumber: iterationRow.iterationNumber,
    status: iterationRow.status,
    attempts: attemptRows
      .filter((attemptRow) => attemptRow.iterationId === iterationRow.id)
      .map((attemptRow) => ({
        attempt: attemptRow.attemptNumber,
        outcome: attemptRow.outcome ?? null,
        output: attemptRow.output ?? null,
        error: attemptRow.error ?? null,
        correlationId: attemptRow.correlationId ?? null,
        sessionId: attemptRow.sessionId ?? null,
        transcript: toTranscript(iterationRow.id, attemptRow.attemptNumber, stepRows, definition),
        evaluatorResults: attemptRow.evaluatorResults,
        reportedAt: attemptRow.reportedAt.toISOString(),
        evaluatedAt: attemptRow.evaluatedAt?.toISOString() ?? null,
      })),
  };
}
