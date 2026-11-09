import { z } from "zod";
import { spanStatusCodeSchema } from "../telemetry/trace-contracts.ts";

/** Letters, digits, `.`, `_` and `-`, starting with a letter or digit, so names are safe in URLs. */
const URL_SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_SAFE_NAME_MESSAGE =
  "Use letters, digits, '.', '_' and '-', starting with a letter or digit.";

/** The longest Output, reported error or serialized input that a request may carry. */
const MAXIMUM_TEXT_LENGTH = 1_000_000;
const REPORTED_ID_MAXIMUM_LENGTH = 256;

/** How many Iterations one request hands out or accepts. */
export const MAXIMUM_BATCH_SIZE = 100;
export const DEFAULT_BATCH_SIZE = 25;

/** The first try of an Iteration and its two retries. */
export const MAXIMUM_ITERATION_ATTEMPTS = 3;

const urlSafeNameSchema = z.string().min(1).max(128).regex(
  URL_SAFE_NAME_PATTERN,
  URL_SAFE_NAME_MESSAGE,
);

/** A Dataset's name, unique within its Project and never changed after creation. */
export const datasetNameSchema = urlSafeNameSchema;

/** A Test Case's name, unique within its Dataset. */
export const testCaseNameSchema = urlSafeNameSchema;

/** Any JSON value of a bounded size, passed to the user's script as given. */
function boundedJsonSchema(fieldName: string) {
  return z.unknown().refine(
    (jsonValue) => jsonValue !== undefined,
    `${fieldName} is required.`,
  ).refine(
    (jsonValue) => (JSON.stringify(jsonValue) ?? "").length <= MAXIMUM_TEXT_LENGTH,
    `${fieldName} must stay below ${MAXIMUM_TEXT_LENGTH} characters as JSON.`,
  );
}

function isValidRegularExpression(pattern: string, flags: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/**
 * A Regex Evaluator. `expectMatch` says whether the Output should match. The flags `g` and `y` are
 * not accepted, because they only change where a repeated match starts.
 */
export const regexEvaluatorSchema = z.strictObject({
  type: z.literal("regex"),
  name: z.string().min(1).max(128),
  pattern: z.string().min(1).max(10_000),
  flags: z.string().regex(/^[imsu]*$/, "Use only the flags i, m, s and u.").default(""),
  expectMatch: z.boolean().default(true),
}).refine(
  (evaluator) => isValidRegularExpression(evaluator.pattern, evaluator.flags),
  { message: "This is not a valid regular expression.", path: ["pattern"] },
);

/** Which spans a Telemetry Evaluator counts. A span must meet every condition that is given. */
export const spanMatchSchema = z.strictObject({
  name: z.string().min(1).max(512).optional(),
  status: spanStatusCodeSchema.optional(),
  /** Attribute values are compared exactly, including their type. */
  attributes: z.record(
    z.string().min(1).max(256),
    z.union([z.string().max(10_000), z.number(), z.boolean()]),
  ).default({}),
}).refine(
  (match) =>
    match.name !== undefined || match.status !== undefined ||
    Object.keys(match.attributes).length > 0,
  "Give at least one condition: a span name, a status or an attribute.",
);

/** How many spans must match. `{ "min": 0, "max": 0 }` means that no span may match. */
export const spanCountSchema = z.strictObject({
  min: z.number().int().min(0).default(1),
  max: z.number().int().min(0).optional(),
}).refine(
  (count) => count.max === undefined || count.max >= count.min,
  "max must not be below min.",
).refine(
  (count) => count.min > 0 || count.max !== undefined,
  "With min 0 and no max, any number of spans would pass. Give a max.",
);

/** Judges the spans of the Iteration's traces: which ones exist, and how many. */
export const telemetryEvaluatorSchema = z.strictObject({
  type: z.literal("telemetry"),
  name: z.string().min(1).max(128),
  match: spanMatchSchema,
  count: spanCountSchema.default({ min: 1 }),
});

/** Grading Evaluators join this list in a later step. */
export const evaluatorSchema = z.discriminatedUnion("type", [
  regexEvaluatorSchema,
  telemetryEvaluatorSchema,
]);

/** A Test Case as a client writes it. Its scope is `trace`; Session scope arrives with its steps. */
export const testCaseDefinitionSchema = z.strictObject({
  scope: z.literal("trace").default("trace"),
  input: boundedJsonSchema("input"),
  expectedOutput: z.string().max(MAXIMUM_TEXT_LENGTH).nullable().default(null),
  evaluators: z.array(evaluatorSchema).min(1).max(20).refine(
    (evaluators) =>
      new Set(evaluators.map((evaluator) => evaluator.name)).size === evaluators.length,
    "Evaluator names must be unique within a Test Case.",
  ),
  iterations: z.number().int().min(1).max(100).default(1),
  passThreshold: z.number().gt(0).max(1).default(1),
});

export const createTestCaseRequestSchema = testCaseDefinitionSchema.extend({
  name: testCaseNameSchema,
});

export const testCaseSchema = testCaseDefinitionSchema.extend({
  name: testCaseNameSchema,
  datasetName: datasetNameSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listTestCasesResponseSchema = z.object({ testCases: z.array(testCaseSchema) });

export const createDatasetRequestSchema = z.strictObject({
  name: datasetNameSchema,
  description: z.string().max(2_000).optional(),
});

export const datasetSchema = z.object({
  name: datasetNameSchema,
  description: z.string(),
  testCaseCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listDatasetsResponseSchema = z.object({ datasets: z.array(datasetSchema) });

export const executionModeSchema = z.enum(["client"]);
export const evaluationRunStatusSchema = z.enum(["running", "finished"]);
export const verdictSchema = z.enum(["passed", "failed", "error"]);
export const iterationStatusSchema = z.enum([
  "awaiting_report",
  "evaluating",
  "passed",
  "failed",
  "error",
]);

export const createEvaluationRunRequestSchema = z.strictObject({
  datasetName: datasetNameSchema,
  executionMode: executionModeSchema,
  /** How many Iterations each response hands to the script. */
  batchSize: z.number().int().min(1).max(MAXIMUM_BATCH_SIZE).default(DEFAULT_BATCH_SIZE),
});

export const iterationWorkItemSchema = z.object({
  iterationId: z.string(),
  attempt: z.number().int(),
  testCaseName: z.string(),
  iterationNumber: z.number().int(),
  input: z.unknown(),
  expectedOutput: z.string().nullable(),
});

/**
 * What a script does next. It runs `items` and reports them. With no `items` and the status
 * `running`, it waits for the worker. `verdict` is set once the status is `finished`.
 */
export const evaluationRunWorkSchema = z.object({
  runId: z.string(),
  status: evaluationRunStatusSchema,
  verdict: verdictSchema.nullable(),
  items: z.array(iterationWorkItemSchema),
  evaluationsInProgress: z.number().int(),
});

const reportedIdSchema = z.string().min(1).max(REPORTED_ID_MAXIMUM_LENGTH);

const reportTargetFields = {
  iterationId: z.string().min(1).max(64),
  attempt: z.number().int().min(1).max(MAXIMUM_ITERATION_ATTEMPTS),
};

const outputReportSchema = z.strictObject({
  ...reportTargetFields,
  output: z.string().max(MAXIMUM_TEXT_LENGTH),
  correlationId: reportedIdSchema,
  sessionId: reportedIdSchema.optional(),
});

/** The application could not produce an Output. The IDs are optional: it may have failed early. */
const errorReportSchema = z.strictObject({
  ...reportTargetFields,
  error: z.string().min(1).max(MAXIMUM_TEXT_LENGTH),
  correlationId: reportedIdSchema.optional(),
  sessionId: reportedIdSchema.optional(),
});

export const iterationReportSchema = z.union([outputReportSchema, errorReportSchema]);

export const reportIterationsRequestSchema = z.strictObject({
  reports: z.array(iterationReportSchema).min(1).max(MAXIMUM_BATCH_SIZE),
});

export const reportRejectionCodeSchema = z.enum([
  "unknown_iteration",
  "stale_attempt",
  "conflicting_report",
  "run_ended",
]);

export const rejectedReportSchema = z.object({
  iterationId: z.string(),
  attempt: z.number().int(),
  code: reportRejectionCodeSchema,
  message: z.string(),
});

export const reportIterationsResponseSchema = evaluationRunWorkSchema.extend({
  rejected: z.array(rejectedReportSchema),
});

/** How many matched spans one result keeps a summary of. */
export const MAXIMUM_MATCHED_SPAN_SUMMARIES = 20;

/** A copy of a matched span's main fields, readable after the telemetry's retention expires. */
export const matchedSpanSummarySchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  name: z.string(),
  statusCode: spanStatusCodeSchema,
  durationMilliseconds: z.number(),
  serviceName: z.string().nullable(),
  /** Only the attributes the Evaluator tested. */
  attributes: z.record(z.string(), z.unknown()),
});

export const evaluatorResultSchema = z.object({
  name: z.string(),
  type: z.enum(["regex", "telemetry"]),
  outcome: verdictSchema,
  reason: z.string(),
  /** Telemetry Evaluators only: how many spans matched, which may exceed the summaries kept. */
  matchedSpanCount: z.number().int().optional(),
  matchedSpans: z.array(matchedSpanSummarySchema).optional(),
});

export const iterationAttemptSchema = z.object({
  attempt: z.number().int(),
  outcome: verdictSchema.nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  correlationId: z.string().nullable(),
  sessionId: z.string().nullable(),
  evaluatorResults: z.array(evaluatorResultSchema),
  reportedAt: z.string(),
  evaluatedAt: z.string().nullable(),
});

export const iterationResultSchema = z.object({
  iterationId: z.string(),
  iterationNumber: z.number().int(),
  status: iterationStatusSchema,
  attempts: z.array(iterationAttemptSchema),
});

/** How many results one page holds. An Iteration may carry three Outputs, so pages stay small. */
export const DEFAULT_RESULT_PAGE_SIZE = 20;
export const MAXIMUM_RESULT_PAGE_SIZE = 50;

/** Reads results in order: `cursor` is the `nextCursor` of the page before. */
export const resultPageQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MAXIMUM_RESULT_PAGE_SIZE).default(
    DEFAULT_RESULT_PAGE_SIZE,
  ),
});

/** Keeps a copy of the Test Case, so that the result stays readable after the Test Case changes. */
export const testCaseResultSchema = z.object({
  name: z.string(),
  outcome: verdictSchema.nullable(),
  input: z.unknown(),
  expectedOutput: z.string().nullable(),
  evaluators: z.array(evaluatorSchema),
  passThreshold: z.number(),
  passedIterations: z.number().int(),
  totalIterations: z.number().int(),
});

export const listTestCaseResultsResponseSchema = z.object({
  testCases: z.array(testCaseResultSchema),
  nextCursor: z.number().int().nullable(),
});

export const listIterationResultsResponseSchema = z.object({
  iterations: z.array(iterationResultSchema),
  nextCursor: z.number().int().nullable(),
});

export const evaluationRunSummarySchema = z.object({
  id: z.string(),
  datasetName: z.string(),
  executionMode: executionModeSchema,
  status: evaluationRunStatusSchema,
  verdict: verdictSchema.nullable(),
  totalIterations: z.number().int(),
  completedIterations: z.number().int(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const listEvaluationRunsQuerySchema = z.object({
  datasetName: datasetNameSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const listEvaluationRunsResponseSchema = z.object({
  evaluationRuns: z.array(evaluationRunSummarySchema),
});

export type Evaluator = z.infer<typeof evaluatorSchema>;
export type RegexEvaluator = z.infer<typeof regexEvaluatorSchema>;
export type TelemetryEvaluator = z.infer<typeof telemetryEvaluatorSchema>;
export type MatchedSpanSummary = z.infer<typeof matchedSpanSummarySchema>;
export type TestCaseDefinition = z.infer<typeof testCaseDefinitionSchema>;
export type TestCaseDefinitionInput = z.input<typeof testCaseDefinitionSchema>;
export type CreateTestCaseRequest = z.input<typeof createTestCaseRequestSchema>;
export type TestCase = z.infer<typeof testCaseSchema>;
export type ListTestCasesResponse = z.infer<typeof listTestCasesResponseSchema>;
export type CreateDatasetRequest = z.infer<typeof createDatasetRequestSchema>;
export type Dataset = z.infer<typeof datasetSchema>;
export type ListDatasetsResponse = z.infer<typeof listDatasetsResponseSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type EvaluationRunStatus = z.infer<typeof evaluationRunStatusSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type IterationStatus = z.infer<typeof iterationStatusSchema>;
export type CreateEvaluationRunRequest = z.input<typeof createEvaluationRunRequestSchema>;
export type IterationWorkItem = z.infer<typeof iterationWorkItemSchema>;
export type EvaluationRunWork = z.infer<typeof evaluationRunWorkSchema>;
export type IterationReport = z.infer<typeof iterationReportSchema>;
export type ReportIterationsRequest = z.infer<typeof reportIterationsRequestSchema>;
export type ReportRejectionCode = z.infer<typeof reportRejectionCodeSchema>;
export type RejectedReport = z.infer<typeof rejectedReportSchema>;
export type ReportIterationsResponse = z.infer<typeof reportIterationsResponseSchema>;
export type EvaluatorResult = z.infer<typeof evaluatorResultSchema>;
export type IterationAttempt = z.infer<typeof iterationAttemptSchema>;
export type IterationResult = z.infer<typeof iterationResultSchema>;
export type TestCaseResult = z.infer<typeof testCaseResultSchema>;
export type EvaluationRunSummary = z.infer<typeof evaluationRunSummarySchema>;
export type ListTestCaseResultsResponse = z.infer<typeof listTestCaseResultsResponseSchema>;
export type ListIterationResultsResponse = z.infer<typeof listIterationResultsResponseSchema>;
export type ListEvaluationRunsResponse = z.infer<typeof listEvaluationRunsResponseSchema>;
