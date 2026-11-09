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
  type TestCaseDefinition,
  type TestCaseResult,
  type Verdict,
} from "@extispex/contracts";
import { type InferEntity, raw } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/sql";
import { decideRunVerdict, decideTestCaseOutcome } from "../evaluation-runs/run-verdicts.ts";
import type { EvaluateAttemptJob } from "../job-queue/job-queue.ts";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import {
  EvaluationRunRecord,
  IterationAttemptRecord,
  IterationRecord,
  RunTestCaseRecord,
  TestCaseRecord,
} from "./evaluation-entities.ts";

type RunRow = InferEntity<typeof EvaluationRunRecord>;
type IterationRow = InferEntity<typeof IterationRecord>;
type AttemptRow = InferEntity<typeof IterationAttemptRecord>;

/** Stays well below the bound-parameter limits of both databases. */
const STATEMENT_CHUNK_SIZE = 500;
const UNFINISHED_STATUSES: IterationStatus[] = ["awaiting_report", "evaluating"];

export const NOT_REPORTED_ERROR = "The Iteration was not reported before the run ended.";
export const NOT_EVALUATED_ERROR = "The Iteration was not evaluated before the run ended.";

export interface NewEvaluationRun {
  projectId: string;
  datasetId: string;
  datasetName: string;
  executionMode: ExecutionMode;
  batchSize: number;
}

export type StartRunResult = { status: "started"; runId: string } | { status: "no_test_cases" };

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
  output: string;
  /** Always set: a report with an Output must carry one. */
  correlationId: string;
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
  ): Promise<void>;
  /** Finds another attempt of the run that used the attempt's Correlation ID or `session.id`. */
  findTelemetryIdConflict(
    job: EvaluateAttemptJob,
    telemetryIds: { correlationId: string; sessionId: string | null },
  ): Promise<TelemetryIdConflict | null>;
  /** The attempt is still waiting for telemetry, so its job does not count as stalled. */
  keepEvaluationWaiting(job: EvaluateAttemptJob, requestedAt: Date): Promise<void>;
  /** Attempts whose job was queued before the cutoff; their request time is set to now. */
  claimStalledEvaluations(cutoff: Date, claimedAt: Date): Promise<EvaluateAttemptJob[]>;
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

/** An attempt ended as Error: the script gets another attempt, or the Iteration ends as `error`. */
async function applyAttemptError(
  entityManager: EntityManager,
  run: RunRow,
  iterationId: string,
  attemptNumber: number,
): Promise<void> {
  await entityManager.nativeUpdate(
    IterationRecord,
    { id: iterationId },
    canRetry(run, attemptNumber)
      ? {
        status: "awaiting_report",
        currentAttempt: attemptNumber + 1,
        evaluationRequestedAt: null,
      }
      : { status: "error", evaluationRequestedAt: null },
  );
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
  const awaitingRows = iterationRows.filter((row) => row.status === "awaiting_report");
  const evaluatingRows = iterationRows.filter((row) => row.status === "evaluating");
  for (const rowChunk of chunk(awaitingRows)) {
    await entityManager.insertMany(
      IterationAttemptRecord,
      rowChunk.map((iterationRow) => ({
        iterationId: iterationRow.id,
        attemptNumber: iterationRow.currentAttempt,
        outcome: "error" as const,
        output: null,
        error: NOT_REPORTED_ERROR,
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
      { status: "error", evaluationRequestedAt: null },
    );
  }
}

function hasSameContent(attemptRow: AttemptRow, report: IterationReport): boolean {
  return (attemptRow.output ?? null) === ("output" in report ? report.output : null) &&
    (attemptRow.error ?? null) === ("error" in report ? report.error : null) &&
    (attemptRow.correlationId ?? undefined) === report.correlationId &&
    (attemptRow.sessionId ?? undefined) === report.sessionId;
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
        let sequence = 0;
        const iterations = runTestCases.flatMap((runTestCase) =>
          Array.from({ length: runTestCase.definition.iterations }, (_, iterationIndex) => ({
            id: crypto.randomUUID(),
            runId,
            runTestCaseId: runTestCase.id,
            sequence: sequence++,
            iterationNumber: iterationIndex + 1,
            status: "awaiting_report" as const,
            currentAttempt: 1,
            evaluationRequestedAt: null,
          }))
        );
        await entityManager.insert(EvaluationRunRecord, {
          id: runId,
          projectId: newRun.projectId,
          datasetName: newRun.datasetName,
          executionMode: newRun.executionMode,
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
        return { status: "started" as const, runId };
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
      const attemptRows = pageRows.length === 0 ? [] : await entityManager.find(
        IterationAttemptRecord,
        { iterationId: { $in: pageRows.map((row) => row.id) } },
        { orderBy: { attemptNumber: "asc" } },
      );
      return {
        iterations: pageRows.map((iterationRow) => toIterationResult(iterationRow, attemptRows)),
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
            input: testCaseRow.definition.input,
            expectedOutput: testCaseRow.definition.expectedOutput,
          };
        }),
        evaluationsInProgress: await entityManager.count(IterationRecord, {
          runId,
          status: "evaluating",
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
          const key = attemptKey(report.iterationId, report.attempt);
          const knownAttempt = knownAttempts.get(key);
          if (knownAttempt !== undefined) {
            if (!hasSameContent(knownAttempt, report)) {
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
          const attemptRow = {
            iterationId: report.iterationId,
            attemptNumber: report.attempt,
            outcome: "error" in report ? "error" as const : null,
            output: "output" in report ? report.output : null,
            error: "error" in report ? report.error : null,
            correlationId: report.correlationId ?? null,
            sessionId: report.sessionId ?? null,
            evaluatorResults: [],
            reportedAt,
            evaluatedAt: null,
          };
          await entityManager.insert(IterationAttemptRecord, attemptRow);
          knownAttempts.set(key, attemptRow as unknown as AttemptRow);
          if ("error" in report) {
            await applyAttemptError(entityManager, runRow, report.iterationId, report.attempt);
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
        await endOpenIterations(entityManager, runId, ["awaiting_report"], requestedAt);
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
      return {
        projectId: runRow.projectId,
        output: attemptRow.output ?? "",
        correlationId: attemptRow.correlationId ?? "",
        sessionId: attemptRow.sessionId ?? null,
        definition: testCaseRow.definition,
        startedAt: previousAttempt === null
          ? runRow.createdAt
          : previousAttempt.evaluatedAt ?? previousAttempt.reportedAt,
        reportedAt: attemptRow.reportedAt,
      };
    },

    async findTelemetryIdConflict(job, { correlationId, sessionId }) {
      const idCondition = sessionId === null
        ? "attempt.correlation_id = ?"
        : "(attempt.correlation_id = ? or attempt.session_id = ?)";
      const rows = await database.orm.em.fork().execute<TelemetryIdConflictRow[]>(
        `select attempt.correlation_id, attempt.attempt_number, iteration.iteration_number,
            test_case.name as test_case_name
          from iteration_attempts attempt
          join iterations iteration on iteration.id = attempt.iteration_id
          join run_test_cases test_case on test_case.id = iteration.run_test_case_id
          where iteration.run_id = (select run_id from iterations where id = ?)
            and ${idCondition}
            and not (attempt.iteration_id = ? and attempt.attempt_number = ?)
          limit 1`,
        [
          job.iterationId,
          correlationId,
          ...(sessionId === null ? [] : [sessionId]),
          job.iterationId,
          job.attemptNumber,
        ],
      );
      if (rows.length === 0) return null;
      return {
        idName: rows[0].correlation_id === correlationId ? "Correlation ID" : "session.id",
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
      await database.orm.em.fork().transactional(async (entityManager) => {
        const unlockedRow = await entityManager.findOne(IterationRecord, { id: job.iterationId });
        if (unlockedRow === null) return;
        const runRow = await lockRun(entityManager, { id: unlockedRow.runId });
        if (runRow === null) return;
        // Read again under the lock: another delivery of this job may have got here first.
        const iterationRow = await entityManager.findOneOrFail(
          IterationRecord,
          { id: job.iterationId },
          { refresh: true },
        );
        if (
          iterationRow.status !== "evaluating" || iterationRow.currentAttempt !== job.attemptNumber
        ) {
          return;
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
        if (outcome === "error") {
          await applyAttemptError(entityManager, runRow, job.iterationId, job.attemptNumber);
        } else {
          await entityManager.nativeUpdate(IterationRecord, { id: job.iterationId }, {
            status: outcome,
            evaluationRequestedAt: null,
          });
        }
        await finalizeRunIfComplete(entityManager, runRow, evaluatedAt);
      });
    },

    async claimStalledEvaluations(cutoff, claimedAt) {
      const entityManager = database.orm.em.fork();
      const iterationRows = await entityManager.find(IterationRecord, {
        status: "evaluating",
        evaluationRequestedAt: { $lt: cutoff },
      }, { limit: STATEMENT_CHUNK_SIZE });
      if (iterationRows.length === 0) return [];
      await entityManager.nativeUpdate(IterationRecord, {
        id: { $in: iterationRows.map((iterationRow) => iterationRow.id) },
        status: "evaluating",
      }, { evaluationRequestedAt: claimedAt });
      return iterationRows.map((iterationRow) => ({
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
    status: runRow.status as EvaluationRunSummary["status"],
    verdict: runRow.verdict ?? null,
    totalIterations: runRow.totalIterations,
    completedIterations,
    createdAt: runRow.createdAt.toISOString(),
    finishedAt: runRow.finishedAt?.toISOString() ?? null,
  };
}

function toTestCaseResult(
  testCaseRow: InferEntity<typeof RunTestCaseRecord>,
  iterationRows: Pick<IterationRow, "status">[],
): TestCaseResult {
  const { input, expectedOutput, evaluators, passThreshold } = testCaseRow.definition;
  return {
    name: testCaseRow.name,
    outcome: testCaseRow.outcome ?? null,
    input,
    expectedOutput,
    evaluators,
    passThreshold,
    passedIterations: iterationRows.filter((row) => row.status === "passed").length,
    totalIterations: iterationRows.length,
  };
}

function toIterationResult(iterationRow: IterationRow, attemptRows: AttemptRow[]): IterationResult {
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
        evaluatorResults: attemptRow.evaluatorResults,
        reportedAt: attemptRow.reportedAt.toISOString(),
        evaluatedAt: attemptRow.evaluatedAt?.toISOString() ?? null,
      })),
  };
}
