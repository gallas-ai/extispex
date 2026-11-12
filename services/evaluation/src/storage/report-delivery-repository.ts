import {
  type ExecutionMode,
  MAXIMUM_REPORTED_TEST_CASES,
  type ReportChannel,
  type ReportDelivery,
  type ReportDeliveryStatus,
  type Verdict,
} from "@extispex/contracts";
import { type InferEntity, raw } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/sql";
import type { DeliverReportJob } from "../job-queue/mod.ts";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import {
  EvaluationRunRecord,
  IterationRecord,
  ReportDeliveryRecord,
  ReportSettingsRecord,
  RunTestCaseRecord,
} from "./evaluation-entities.ts";

type DeliveryRow = InferEntity<typeof ReportDeliveryRecord>;
type RunTestCaseRow = InferEntity<typeof RunTestCaseRecord>;

/** A worker that has not finished sending after this long has died; another may take over. */
const SENDING_CLAIM_MILLISECONDS = 120_000;
const STALLED_BATCH_SIZE = 500;

/** A delivery that the worker has taken, with the attempt it is making. */
export interface ClaimedDelivery {
  deliveryId: string;
  runId: string;
  projectId: string;
  channel: ReportChannel;
  attemptNumber: number;
}

/** A Test Case that did not pass, as a Report lists it. */
export interface UnsuccessfulTestCase {
  name: string;
  outcome: "failed" | "error";
  passedIterations: number;
  totalIterations: number;
}

/** Everything a Report says about a finished run. */
export interface ReportFacts {
  runId: string;
  projectId: string;
  datasetName: string;
  executionMode: ExecutionMode;
  targetName: string | null;
  verdict: Verdict;
  createdAt: Date;
  finishedAt: Date;
  testCaseCounts: Record<Verdict, number>;
  /** Failed Test Cases first, then those that ended as Error, each in the run's order. */
  unsuccessfulTestCases: UnsuccessfulTestCase[];
  /** Null when the run has no LLM Summary, or not yet. */
  llmSummary: string | null;
}

/** Whether a delivery should wait for its run's LLM Summary. */
export interface LlmSummaryWait {
  isLlmSummaryPending: boolean;
  finishedAt: Date;
}

export interface ReportDeliveryRepository {
  /** Null when the run does not exist in the Project. */
  listDeliveries(projectId: string, runId: string): Promise<ReportDelivery[] | null>;
  /**
   * Takes a delivery for this worker and counts the attempt. Null when it was delivered, gave up,
   * or another worker is sending it, so that a repeated job sends nothing twice.
   */
  claimDelivery(deliveryId: string, claimedAt: Date): Promise<ClaimedDelivery | null>;
  recordDelivered(claim: ClaimedDelivery, deliveredAt: Date): Promise<void>;
  /** With `retryAt`, the delivery waits for another attempt; without, it has failed for good. */
  recordFailure(claim: ClaimedDelivery, error: string, retryAt: Date | null): Promise<void>;
  /** Deliveries whose job should have run before the cutoff; they are due again now. */
  claimStalledDeliveries(cutoff: Date, claimedAt: Date): Promise<DeliverReportJob[]>;
  /** Null when the run does not exist or has not finished. */
  readReportFacts(runId: string): Promise<ReportFacts | null>;
  /** Null when the delivery or its run no longer exists, or the run has not finished. */
  readLlmSummaryWait(deliveryId: string): Promise<LlmSummaryWait | null>;
  /** A delivery that waits for the LLM Summary is due again later, so it does not look stalled. */
  postponeDelivery(deliveryId: string, dueAt: Date): Promise<void>;
}

/**
 * Creates the Report deliveries of a run that has just finished, in the transaction that finished
 * it, so that a run never finishes without them. The result is the jobs to queue after commit.
 */
export async function scheduleReportDeliveries(
  entityManager: EntityManager,
  run: { id: string; projectId: string },
  verdict: Verdict,
  finishedAt: Date,
): Promise<DeliverReportJob[]> {
  const settings = await entityManager.findOne(ReportSettingsRecord, {
    projectId: run.projectId,
  });
  if (settings === null) return [];
  if (settings.condition === "on_failure" && verdict === "passed") return [];
  const channels: ReportChannel[] = [];
  if (settings.emailChannel != null) channels.push("email");
  if (settings.sealedTeamsWebhookUrl != null) channels.push("teams");
  if (channels.length === 0) return [];
  const rows = channels.map((channel) => ({
    id: crypto.randomUUID(),
    runId: run.id,
    channel,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    dueAt: finishedAt,
    deliveredAt: null,
    createdAt: finishedAt,
  }));
  await entityManager.insertMany(ReportDeliveryRecord, rows);
  return rows.map((row) => ({ kind: "deliver-report", deliveryId: row.id }));
}

function toReportDelivery(row: DeliveryRow): ReportDelivery {
  const status = row.status as ReportDeliveryStatus;
  return {
    channel: row.channel as ReportChannel,
    status,
    attempts: row.attemptCount,
    lastError: row.lastError ?? null,
    nextAttemptAt: status === "pending" && row.attemptCount > 0 ? row.dueAt.toISOString() : null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}

export function createReportDeliveryRepository(
  database: EvaluationDatabase,
): ReportDeliveryRepository {
  /** Only the worker that made this attempt may record how it ended. */
  const claimCondition = (claim: ClaimedDelivery) => ({
    id: claim.deliveryId,
    status: "sending",
    attemptCount: claim.attemptNumber,
  });

  return {
    async listDeliveries(projectId, runId) {
      const entityManager = database.orm.em.fork();
      if (await entityManager.count(EvaluationRunRecord, { id: runId, projectId }) === 0) {
        return null;
      }
      const rows = await entityManager.find(
        ReportDeliveryRecord,
        { runId },
        { orderBy: { channel: "asc" } },
      );
      return rows.map(toReportDelivery);
    },

    async claimDelivery(deliveryId, claimedAt) {
      const entityManager = database.orm.em.fork();
      const claimExpiredBefore = new Date(claimedAt.getTime() - SENDING_CLAIM_MILLISECONDS);
      // One statement, so that of two deliveries of the job only one changes the row.
      const claimedCount = await entityManager.nativeUpdate(ReportDeliveryRecord, {
        id: deliveryId,
        $or: [
          { status: "pending" },
          { status: "sending", dueAt: { $lt: claimExpiredBefore } },
        ],
      }, { status: "sending", attemptCount: raw("attempt_count + 1"), dueAt: claimedAt });
      if (claimedCount === 0) return null;
      const row = await entityManager.findOneOrFail(ReportDeliveryRecord, { id: deliveryId });
      const runRow = await entityManager.findOneOrFail(EvaluationRunRecord, { id: row.runId });
      return {
        deliveryId,
        runId: row.runId,
        projectId: runRow.projectId,
        channel: row.channel as ReportChannel,
        attemptNumber: row.attemptCount,
      };
    },

    async recordDelivered(claim, deliveredAt) {
      await database.orm.em.fork().nativeUpdate(ReportDeliveryRecord, claimCondition(claim), {
        status: "delivered",
        lastError: null,
        deliveredAt,
      });
    },

    async recordFailure(claim, error, retryAt) {
      await database.orm.em.fork().nativeUpdate(ReportDeliveryRecord, claimCondition(claim), {
        status: retryAt === null ? "failed" : "pending",
        lastError: error,
        ...(retryAt === null ? {} : { dueAt: retryAt }),
      });
    },

    async claimStalledDeliveries(cutoff, claimedAt) {
      const entityManager = database.orm.em.fork();
      const rows = await entityManager.find(ReportDeliveryRecord, {
        status: { $in: ["pending", "sending"] },
        dueAt: { $lt: cutoff },
      }, { limit: STALLED_BATCH_SIZE });
      if (rows.length === 0) return [];
      await entityManager.nativeUpdate(ReportDeliveryRecord, {
        id: { $in: rows.map((row) => row.id) },
        status: { $in: ["pending", "sending"] },
        dueAt: { $lt: cutoff },
      }, { status: "pending", dueAt: claimedAt });
      return rows.map((row) => ({ kind: "deliver-report", deliveryId: row.id }));
    },

    async readReportFacts(runId) {
      const entityManager = database.orm.em.fork();
      const runRow = await entityManager.findOne(EvaluationRunRecord, { id: runId });
      if (runRow === null || runRow.verdict == null || runRow.finishedAt == null) return null;
      const testCaseCounts: Record<Verdict, number> = { passed: 0, failed: 0, error: 0 };
      for (const outcome of ["passed", "failed", "error"] as const) {
        testCaseCounts[outcome] = await entityManager.count(RunTestCaseRecord, { runId, outcome });
      }
      const unsuccessfulRows: RunTestCaseRow[] = [];
      for (const outcome of ["failed", "error"] as const) {
        const remaining: number = MAXIMUM_REPORTED_TEST_CASES - unsuccessfulRows.length;
        if (remaining === 0) break;
        unsuccessfulRows.push(
          ...await entityManager.find(
            RunTestCaseRecord,
            { runId, outcome },
            { orderBy: { position: "asc" }, limit: remaining },
          ),
        );
      }
      const iterationRows = unsuccessfulRows.length === 0 ? [] : await entityManager.find(
        IterationRecord,
        { runTestCaseId: { $in: unsuccessfulRows.map((row) => row.id) } },
        { fields: ["runTestCaseId", "status"] },
      );
      return {
        runId,
        projectId: runRow.projectId,
        datasetName: runRow.datasetName,
        executionMode: runRow.executionMode as ExecutionMode,
        targetName: runRow.targetName ?? null,
        verdict: runRow.verdict,
        createdAt: runRow.createdAt,
        finishedAt: runRow.finishedAt,
        testCaseCounts,
        unsuccessfulTestCases: unsuccessfulRows.map((testCaseRow) => {
          const iterations = iterationRows.filter((row) => row.runTestCaseId === testCaseRow.id);
          return {
            name: testCaseRow.name,
            outcome: testCaseRow.outcome as "failed" | "error",
            passedIterations: iterations.filter((row) => row.status === "passed").length,
            totalIterations: iterations.length,
          };
        }),
        llmSummary: runRow.summaryStatus === "completed" ? runRow.summaryText ?? null : null,
      };
    },

    async readLlmSummaryWait(deliveryId) {
      const entityManager = database.orm.em.fork();
      const row = await entityManager.findOne(ReportDeliveryRecord, { id: deliveryId });
      if (row === null) return null;
      const runRow = await entityManager.findOne(EvaluationRunRecord, { id: row.runId });
      if (runRow?.finishedAt == null) return null;
      return {
        isLlmSummaryPending: runRow.summaryStatus === "pending" ||
          runRow.summaryStatus === "generating",
        finishedAt: runRow.finishedAt,
      };
    },

    async postponeDelivery(deliveryId, dueAt) {
      await database.orm.em.fork().nativeUpdate(ReportDeliveryRecord, {
        id: deliveryId,
        status: "pending",
      }, { dueAt });
    },
  };
}
