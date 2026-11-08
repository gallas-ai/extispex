import type {
  EvaluatorResult,
  IterationStatus,
  TestCaseDefinition,
  Verdict,
} from "@extispex/contracts";
import { defineEntity, p } from "@mikro-orm/core";

export const DatasetRecord = defineEntity({
  name: "DatasetRecord",
  tableName: "datasets",
  properties: {
    id: p.string().primary(),
    projectId: p.string(),
    name: p.string(),
    description: p.text(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
  uniques: [{ properties: ["projectId", "name"] }],
  indexes: [{ properties: ["projectId", "updatedAt"] }],
});

export const TestCaseRecord = defineEntity({
  name: "TestCaseRecord",
  tableName: "test_cases",
  properties: {
    id: p.string().primary(),
    datasetId: p.string(),
    name: p.string(),
    definition: p.json<TestCaseDefinition>(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
  uniques: [{ properties: ["datasetId", "name"] }],
});

/**
 * An Evaluation Run. Every change to a run or its Iterations first increments `revision`, which
 * locks this row until commit, so concurrent reports and evaluations of one run queue up and
 * exactly one of them sees that the last Iteration has ended.
 */
export const EvaluationRunRecord = defineEntity({
  name: "EvaluationRunRecord",
  tableName: "evaluation_runs",
  properties: {
    id: p.string().primary(),
    projectId: p.string(),
    datasetName: p.string(),
    executionMode: p.string(),
    status: p.string(),
    verdict: p.string().$type<Verdict>().nullable(),
    batchSize: p.integer(),
    totalIterations: p.integer(),
    revision: p.integer(),
    finishRequestedAt: p.datetime().nullable(),
    lastActivityAt: p.datetime(),
    createdAt: p.datetime(),
    finishedAt: p.datetime().nullable(),
  },
  indexes: [
    { properties: ["projectId", "createdAt"] },
    { properties: ["status", "lastActivityAt"] },
  ],
});

/** A run's own copy of a Test Case, so that later changes to the Dataset cannot affect it. */
export const RunTestCaseRecord = defineEntity({
  name: "RunTestCaseRecord",
  tableName: "run_test_cases",
  properties: {
    id: p.string().primary(),
    runId: p.string(),
    position: p.integer(),
    name: p.string(),
    definition: p.json<TestCaseDefinition>(),
    outcome: p.string().$type<Verdict>().nullable(),
  },
  uniques: [{ properties: ["runId", "position"] }],
});

export const IterationRecord = defineEntity({
  name: "IterationRecord",
  tableName: "iterations",
  properties: {
    id: p.string().primary(),
    runId: p.string(),
    runTestCaseId: p.string(),
    /** The order in which the run hands out its Iterations. */
    sequence: p.integer(),
    iterationNumber: p.integer(),
    status: p.string().$type<IterationStatus>(),
    currentAttempt: p.integer(),
    /** When a job for the current attempt was last queued; null unless `evaluating`. */
    evaluationRequestedAt: p.datetime().nullable(),
  },
  uniques: [
    { properties: ["runId", "sequence"] },
    { properties: ["runTestCaseId", "iterationNumber"] },
  ],
  indexes: [
    { properties: ["runId", "status", "sequence"] },
    { properties: ["status", "evaluationRequestedAt"] },
  ],
});

export const IterationAttemptRecord = defineEntity({
  name: "IterationAttemptRecord",
  tableName: "iteration_attempts",
  properties: {
    iterationId: p.string().primary(),
    attemptNumber: p.integer().primary(),
    outcome: p.string().$type<Verdict>().nullable(),
    output: p.text().nullable(),
    error: p.text().nullable(),
    correlationId: p.string().nullable(),
    sessionId: p.string().nullable(),
    evaluatorResults: p.json<EvaluatorResult[]>(),
    reportedAt: p.datetime(),
    evaluatedAt: p.datetime().nullable(),
  },
});

/** The local image's job queue; PostgreSQL deployments use pg-boss instead. */
export const QueuedJobRecord = defineEntity({
  name: "QueuedJobRecord",
  tableName: "queued_jobs",
  properties: {
    id: p.string().primary(),
    payload: p.json<Record<string, unknown>>(),
    deliveryCount: p.integer(),
    /** The job is not delivered before this time: a retry's delay or a worker's lease. */
    availableAt: p.datetime(),
  },
  indexes: [{ properties: ["availableAt"] }],
});
