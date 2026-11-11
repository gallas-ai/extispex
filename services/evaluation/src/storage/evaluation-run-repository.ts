import {
  type EvaluationRunSummary,
  type EvaluationRunWork,
  type EvaluatorResult,
  type ExecutionMode,
  type IterationReport,
  type IterationResult,
  type IterationStatus,
  type ListIterationResultsResponse,
  type ListTestCaseResultsResponse,
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
import type { AttemptJob, EvaluateAttemptJob, ExecuteAttemptJob } from "../job-queue/mod.ts";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import {
  EvaluationRunRecord,
  IterationAttemptRecord,
  IterationAttemptStepRecord,
  IterationRecord,
  RunTestCaseRecord,
  TestCaseRecord,
} from "./evaluation-entities.ts";

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
  /** Attempts with an Output, to be queued after the reports were stored. */
  jobs: EvaluateAttemptJob[];
}

export interface ResultPage {
  cursor?: number;
  limit: number;
}

export interface AttemptToEvaluate {
  projectId: string;
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
  readRun(projectId: string, runId: string): Promise<EvaluationRunSummary | null>;
  /** Null when the run does not exist. */
  listTestCaseResults(
    projectId: string,
    runId: string,
    page: ResultPage,
  ): Promise<ListTestCaseResultsResponse | null>;
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
  /** False when the run does not exist. */
  requestFinish(projectId: string, runId: string, requestedAt: Date): Promise<boolean>;
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
  ): Promise<ExecuteAttemptJob[]>;
  /**
   * Takes the attempt for this worker. Null when it is no longer waiting to be executed, or when
   * another worker is calling the Target, so that a repeated job does not call it twice.
   */
  claimAttemptExecution(job: ExecuteAttemptJob, claimedAt: Date): Promise<AttemptToExecute | null>;
  /** The worker is still calling the Target, so its claim holds and its job is not stalled. */
  renewAttemptExecution(job: ExecuteAttemptJob, renewedAt: Date): Promise<void>;
  /**
   * Stores what the Target returned. Does nothing when the attempt is no longer being executed.
   * The result is the job to queue next: its evaluation, or another attempt after an Error.
   */
  recordExecution(
    job: ExecuteAttemptJob,
    result: ExecutionResult,
    recordedAt: Date,
  ): Promise<AttemptJob[]>;
  /** Finds another attempt of the run that used one of the attempt's IDs. */
  findTelemetryIdConflict(
    job: EvaluateAttemptJob,
    telemetryIds: { correlationIds: string[]; sessionId: string | null },
  ): Promise<TelemetryIdConflict | null>;
  /** The attempt is still waiting for telemetry, so its job does not count as stalled. */
  keepEvaluationWaiting(job: EvaluateAttemptJob, requestedAt: Date): Promise<void>;
  /** Attempts whose job was queued before the cutoff; their request time is set to now. */
  claimStalledEvaluations(cutoff: Date, claimedAt: Date): Promise<AttemptJob[]>;
  /** Ends runs without activity since the cutoff; resolves to how many ended. */
  endInactiveRuns(cutoff: Date, endedAt: Date): Promise<number>;
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

/** Sets the verdicts once no Iteration is open. A finished run is never changed again. */
async function finalizeRunIfComplete(
  entityManager: EntityManager,
  run: RunRow,
  finishedAt: Date,
): Promise<void> {
  if (run.status === "finished") return;
  const openCount = await entityManager.count(IterationRecord, {
    runId: run.id,
    status: { $in: UNFINISHED_STATUSES },
  });
  if (openCount > 0) return;
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
  await entityManager.nativeUpdate(EvaluationRunRecord, { id: run.id }, {
    status: "finished",
    verdict: decideRunVerdict([...idsByOutcome.keys()]),
    finishedAt,
  });
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
      return toRunSummary(runRow, runRow.totalIterations - openCount);
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
        const jobs: EvaluateAttemptJob[] = [];
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
        await finalizeRunIfComplete(entityManager, runRow, reportedAt);
        return { rejected, jobs };
      });
    },

    async requestFinish(projectId, runId, requestedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const runRow = await lockRun(entityManager, { id: runId, projectId });
        if (runRow === null) return false;
        if (runRow.status === "finished") return true;
        await entityManager.nativeUpdate(EvaluationRunRecord, { id: runId }, {
          finishRequestedAt: runRow.finishRequestedAt ?? requestedAt,
        });
        await endOpenIterations(
          entityManager,
          runId,
          ["awaiting_report", "executing"],
          requestedAt,
        );
        await finalizeRunIfComplete(entityManager, runRow, requestedAt);
        return true;
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
        let nextJobs: ExecuteAttemptJob[] = [];
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
        await finalizeRunIfComplete(entityManager, runRow, evaluatedAt);
        return nextJobs;
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
        let nextJobs: AttemptJob[];
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
        await finalizeRunIfComplete(entityManager, runRow, recordedAt);
        return nextJobs;
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
      return iterationRows.map((iterationRow): AttemptJob => ({
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
      let endedCount = 0;
      for (const inactiveRow of inactiveRows) {
        const hasEnded = await database.orm.em.fork().transactional(async (entityManager) => {
          const runRow = await lockRun(entityManager, { id: inactiveRow.id });
          // A report may have arrived since the search above.
          if (runRow === null || runRow.status === "finished" || runRow.lastActivityAt >= cutoff) {
            return false;
          }
          await endOpenIterations(entityManager, runRow.id, UNFINISHED_STATUSES, endedAt);
          await finalizeRunIfComplete(entityManager, runRow, endedAt);
          return true;
        });
        if (hasEnded) endedCount++;
      }
      return endedCount;
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
