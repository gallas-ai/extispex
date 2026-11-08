import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  Dataset,
  EvaluationRunSummary,
  EvaluationRunWork,
  IterationReport,
  ListDatasetsResponse,
  ListEvaluationRunsResponse,
  ListIterationResultsResponse,
  ListTestCaseResultsResponse,
  ListTestCasesResponse,
  ReportIterationsResponse,
  TestCase,
} from "@extispex/contracts";
import {
  createRequestAuthenticator,
  createStructuredLogger,
  type ProjectResolver,
} from "@extispex/service-runtime";
import { createTestAccessTokens } from "@extispex/service-runtime/testing";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  createEvaluationApiService,
  createEvaluationWorker,
  type EvaluateAttemptJob,
  type EvaluationApiService,
  type EvaluationWorker,
  type JobQueue,
  openEvaluationDatabase,
} from "../src/create-service.ts";
import {
  NOT_EVALUATED_ERROR,
  NOT_REPORTED_ERROR,
} from "../src/storage/evaluation-run-repository.ts";

const API_KEY = "test-api-key";
const OTHER_PROJECT_API_KEY = "other-project-api-key";
const INACTIVE_RUN_TIMEOUT_MILLISECONDS = 3_600_000;

const testProjectResolver: ProjectResolver = {
  resolveProjectId: (apiKey) =>
    Promise.resolve(
      ({ [API_KEY]: "project-one", [OTHER_PROJECT_API_KEY]: "project-two" })[apiKey] ?? null,
    ),
};
const testAccessTokens = await createTestAccessTokens();
const testRequestAuthenticator = createRequestAuthenticator({
  projectResolver: testProjectResolver,
  accessTokenVerifier: testAccessTokens.accessTokenVerifier,
});

const MENTIONS_DAYS_EVALUATOR = {
  type: "regex",
  name: "mentions-days",
  pattern: "30\\s*days",
  flags: "i",
};

interface TestHarness {
  api: EvaluationApiService;
  worker: EvaluationWorker;
  queuedJobs: EvaluateAttemptJob[];
  advanceClock(milliseconds: number): void;
  /** Judges everything queued so far, as the worker would. */
  drainJobs(): Promise<void>;
}

type EvaluationTestBody = (harness: TestHarness) => Promise<void>;

function defineEvaluationTest(testName: string, testBody: EvaluationTestBody): void {
  for (const testDatabase of listTestDatabases("evaluation")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openEvaluationDatabase(testDatabase.url);
      try {
        const entityManager = database.orm.em.fork();
        await entityManager.execute("delete from evaluation_runs");
        await entityManager.execute("delete from datasets");
        let clockMilliseconds = Date.parse("2026-11-08T10:00:00Z");
        const readCurrentTime = () => new Date(clockMilliseconds += 1_000);
        const queuedJobs: EvaluateAttemptJob[] = [];
        const jobQueue: JobQueue = {
          enqueue: (jobs) => {
            queuedJobs.push(...jobs);
            return Promise.resolve();
          },
          startWorking: () => Promise.resolve(),
          stop: () => Promise.resolve(),
        };
        const logger = createStructuredLogger("evaluation-test");
        const worker = createEvaluationWorker({
          database,
          jobQueue,
          logger,
          regexTimeoutMilliseconds: 300,
          inactiveRunTimeoutMilliseconds: INACTIVE_RUN_TIMEOUT_MILLISECONDS,
          readCurrentTime,
        });
        await testBody({
          api: createEvaluationApiService({
            database,
            jobQueue,
            requestAuthenticator: testRequestAuthenticator,
            logger,
            readCurrentTime,
          }),
          worker,
          queuedJobs,
          advanceClock: (milliseconds) => {
            clockMilliseconds += milliseconds;
          },
          drainJobs: async () => {
            for (const job of queuedJobs.splice(0)) await worker.evaluateAttempt(job);
          },
        });
      } finally {
        await database.close();
      }
    });
  }
}

async function sendRequest(
  { api }: TestHarness,
  method: string,
  path: string,
  options: { body?: unknown; bearerToken?: string } = {},
): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${options.bearerToken ?? API_KEY}` });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return await api.handleRequest(
    new Request(`http://evaluation.test${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

async function expectJson<ResponseBody>(
  responsePromise: Promise<Response>,
  expectedStatus: number,
): Promise<ResponseBody> {
  const response = await responsePromise;
  const responseText = await response.text();
  assertEquals(response.status, expectedStatus, responseText);
  return (responseText === "" ? null : JSON.parse(responseText)) as ResponseBody;
}

async function createDatasetWithTestCases(
  harness: TestHarness,
  testCases: Record<string, unknown>[],
): Promise<void> {
  await expectJson(
    sendRequest(harness, "POST", "/v1/datasets", { body: { name: "support-bot" } }),
    201,
  );
  for (const testCase of testCases) {
    await expectJson(
      sendRequest(harness, "POST", "/v1/datasets/support-bot/test-cases", { body: testCase }),
      201,
    );
  }
}

function refundTestCase(overrides: Record<string, unknown> = {}) {
  return {
    name: "refund",
    input: { message: "What is your refund policy?" },
    evaluators: [MENTIONS_DAYS_EVALUATOR],
    ...overrides,
  };
}

function startRun(harness: TestHarness, batchSize?: number) {
  return expectJson<EvaluationRunWork>(
    sendRequest(harness, "POST", "/v1/evaluation-runs", {
      body: { datasetName: "support-bot", executionMode: "client", batchSize },
    }),
    201,
  );
}

function report(harness: TestHarness, runId: string, reports: IterationReport[]) {
  return expectJson<ReportIterationsResponse>(
    sendRequest(harness, "POST", `/v1/evaluation-runs/${runId}/reports`, { body: { reports } }),
    200,
  );
}

/** A run with every result, read page by page like a client does. */
async function readRun(harness: TestHarness, runId: string) {
  const runPath = `/v1/evaluation-runs/${runId}`;
  const summary = await expectJson<EvaluationRunSummary>(
    sendRequest(harness, "GET", runPath),
    200,
  );
  const testCases = [];
  let cursor: number | null = null;
  do {
    const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
    const page: ListTestCaseResultsResponse = await expectJson(
      sendRequest(harness, "GET", `${runPath}/test-cases${query}`),
      200,
    );
    for (const testCase of page.testCases) {
      const iterations = [];
      let iterationCursor: number | null = null;
      do {
        const iterationQuery: string = iterationCursor === null
          ? "?limit=3"
          : `?limit=3&cursor=${iterationCursor}`;
        const iterationPage: ListIterationResultsResponse = await expectJson(
          sendRequest(
            harness,
            "GET",
            `${runPath}/test-cases/${testCase.name}/iterations${iterationQuery}`,
          ),
          200,
        );
        iterations.push(...iterationPage.iterations);
        iterationCursor = iterationPage.nextCursor;
      } while (iterationCursor !== null);
      testCases.push({ ...testCase, iterations });
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { ...summary, testCases };
}

function outputReport(
  item: { iterationId: string; attempt: number },
  output: string,
): IterationReport {
  return {
    iterationId: item.iterationId,
    attempt: item.attempt,
    output,
    correlationId: `correlation-${item.iterationId}-${item.attempt}`,
  };
}

function errorReport(item: { iterationId: string; attempt: number }): IterationReport {
  return { iterationId: item.iterationId, attempt: item.attempt, error: "HTTP 500 from the app" };
}

defineEvaluationTest("manages Datasets and Test Cases", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const { datasets } = await expectJson<ListDatasetsResponse>(
    sendRequest(harness, "GET", "/v1/datasets"),
    200,
  );
  assertEquals(datasets.map((dataset) => [dataset.name, dataset.testCaseCount]), [
    ["support-bot", 1],
  ]);

  const testCasePath = "/v1/datasets/support-bot/test-cases/refund";
  const stored = await expectJson<TestCase>(sendRequest(harness, "GET", testCasePath), 200);
  assertEquals(stored.scope, "trace");
  assertEquals(stored.iterations, 1);
  assertEquals(stored.passThreshold, 1);
  assertEquals(stored.expectedOutput, null);
  assertEquals(stored.evaluators[0].expectMatch, true);

  const { name: _name, ...replacement } = refundTestCase({ iterations: 3, passThreshold: 0.66 });
  const updated = await expectJson<TestCase>(
    sendRequest(harness, "PUT", testCasePath, { body: replacement }),
    200,
  );
  assertEquals([updated.iterations, updated.passThreshold], [3, 0.66]);

  assertEquals((await sendRequest(harness, "DELETE", testCasePath)).status, 204);
  const { testCases } = await expectJson<ListTestCasesResponse>(
    sendRequest(harness, "GET", "/v1/datasets/support-bot/test-cases"),
    200,
  );
  assertEquals(testCases, []);
  assertEquals((await sendRequest(harness, "DELETE", "/v1/datasets/support-bot")).status, 204);
  await expectJson<Dataset>(sendRequest(harness, "GET", "/v1/datasets/support-bot"), 404);
});

defineEvaluationTest("refuses duplicate names and invalid Test Cases", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  await expectJson(
    sendRequest(harness, "POST", "/v1/datasets", { body: { name: "support-bot" } }),
    409,
  );
  const path = "/v1/datasets/support-bot/test-cases";
  await expectJson(sendRequest(harness, "POST", path, { body: refundTestCase() }), 409);
  for (
    const invalidTestCase of [
      refundTestCase({
        name: "bad-pattern",
        evaluators: [{ ...MENTIONS_DAYS_EVALUATOR, pattern: "(" }],
      }),
      refundTestCase({
        name: "bad-flags",
        evaluators: [{ ...MENTIONS_DAYS_EVALUATOR, flags: "g" }],
      }),
      refundTestCase({ name: "no-evaluators", evaluators: [] }),
      refundTestCase({
        name: "same-names",
        evaluators: [MENTIONS_DAYS_EVALUATOR, MENTIONS_DAYS_EVALUATOR],
      }),
      refundTestCase({ name: "no-threshold", passThreshold: 0 }),
      { name: "no-input", evaluators: [MENTIONS_DAYS_EVALUATOR] },
      refundTestCase({ name: "unknown-field", iteration: 3 }),
    ]
  ) {
    await expectJson(sendRequest(harness, "POST", path, { body: invalidTestCase }), 400);
  }
});

defineEvaluationTest("keeps Projects apart and enforces Roles", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const work = await startRun(harness);
  const otherKey = { bearerToken: OTHER_PROJECT_API_KEY };
  await expectJson(sendRequest(harness, "GET", "/v1/datasets/support-bot", otherKey), 404);
  await expectJson(sendRequest(harness, "GET", `/v1/evaluation-runs/${work.runId}`, otherKey), 404);
  await expectJson(
    sendRequest(harness, "POST", `/v1/evaluation-runs/${work.runId}/finish`, otherKey),
    404,
  );
  const viewerToken = await testAccessTokens.issueAccessToken({
    projectId: "project-one",
    role: "viewer",
  });
  await expectJson(
    sendRequest(harness, "GET", "/v1/datasets", { bearerToken: viewerToken }),
    200,
  );
  await expectJson(
    sendRequest(harness, "POST", "/v1/datasets", {
      bearerToken: viewerToken,
      body: { name: "not-allowed" },
    }),
    403,
  );
  await expectJson(sendRequest(harness, "GET", "/v1/datasets", { bearerToken: "wrong" }), 401);
});

defineEvaluationTest("refuses a run of a missing or empty Dataset", async (harness) => {
  const body = { datasetName: "support-bot", executionMode: "client" };
  await expectJson(sendRequest(harness, "POST", "/v1/evaluation-runs", { body }), 404);
  await createDatasetWithTestCases(harness, []);
  await expectJson(sendRequest(harness, "POST", "/v1/evaluation-runs", { body }), 409);
});

defineEvaluationTest("judges reported Outputs and ends the run by itself", async (harness) => {
  await createDatasetWithTestCases(harness, [
    refundTestCase({ expectedOutput: "Refunds within 30 days." }),
    refundTestCase({ name: "shipping", input: "How long?" }),
  ]);
  const firstWork = await startRun(harness);
  assertEquals(firstWork.status, "running");
  assertEquals(firstWork.items.map((item) => item.testCaseName), ["refund", "shipping"]);
  assertEquals(firstWork.items[0].expectedOutput, "Refunds within 30 days.");
  assertEquals(firstWork.items[0].input, { message: "What is your refund policy?" });

  const [refundItem, shippingItem] = firstWork.items;
  const afterReports = await report(harness, firstWork.runId, [
    outputReport(refundItem, "Within 30 days."),
    outputReport(shippingItem, "Soon."),
  ]);
  assertEquals(afterReports.rejected, []);
  assertEquals(afterReports.items, []);
  assertEquals(afterReports.status, "running");
  assertEquals(afterReports.evaluationsInProgress, 2);

  await harness.drainJobs();
  const finishedWork = await expectJson<EvaluationRunWork>(
    sendRequest(harness, "GET", `/v1/evaluation-runs/${firstWork.runId}/work`),
    200,
  );
  assertEquals([finishedWork.status, finishedWork.verdict], ["finished", "failed"]);

  const run = await readRun(harness, firstWork.runId);
  assertEquals(run.completedIterations, 2);
  assert(run.finishedAt !== null);
  assertEquals(run.testCases.map((testCase) => testCase.outcome), ["passed", "failed"]);
  const refundAttempt = run.testCases[0].iterations[0].attempts[0];
  assertEquals(refundAttempt.output, "Within 30 days.");
  assertEquals(refundAttempt.correlationId, `correlation-${refundItem.iterationId}-1`);
  assertEquals(refundAttempt.evaluatorResults[0].outcome, "passed");
  assertStringIncludes(
    run.testCases[1].iterations[0].attempts[0].evaluatorResults[0].reason,
    "does not match",
  );
});

defineEvaluationTest("hands out work in batches of the run's size", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase({ iterations: 5 })]);
  const firstWork = await startRun(harness, 2);
  assertEquals(firstWork.items.map((item) => item.iterationNumber), [1, 2]);
  const secondWork = await report(
    harness,
    firstWork.runId,
    firstWork.items.map((item) => outputReport(item, "30 days")),
  );
  assertEquals(secondWork.items.map((item) => item.iterationNumber), [3, 4]);
});

defineEvaluationTest("applies the Pass Threshold", async (harness) => {
  await createDatasetWithTestCases(harness, [
    refundTestCase({ iterations: 3, passThreshold: 0.66 }),
  ]);
  const work = await startRun(harness);
  await report(harness, work.runId, [
    outputReport(work.items[0], "30 days"),
    outputReport(work.items[1], "30 days"),
    outputReport(work.items[2], "no idea"),
  ]);
  await harness.drainJobs();
  const run = await readRun(harness, work.runId);
  assertEquals([run.verdict, run.testCases[0].passedIterations], ["passed", 2]);
});

defineEvaluationTest(
  "offers two retries for a reported Error, with a new attempt",
  async (harness) => {
    await createDatasetWithTestCases(harness, [refundTestCase()]);
    const firstWork = await startRun(harness);
    const secondWork = await report(harness, firstWork.runId, [errorReport(firstWork.items[0])]);
    assertEquals(secondWork.items.map((item) => item.attempt), [2]);
    const thirdWork = await report(harness, firstWork.runId, [errorReport(secondWork.items[0])]);
    assertEquals(thirdWork.items.map((item) => item.attempt), [3]);
    const lastWork = await report(harness, firstWork.runId, [errorReport(thirdWork.items[0])]);
    assertEquals(lastWork.items, []);
    assertEquals([lastWork.status, lastWork.verdict], ["finished", "error"]);
    const run = await readRun(harness, firstWork.runId);
    assertEquals(run.testCases[0].outcome, "error");
    assertEquals(run.testCases[0].iterations[0].attempts.map((attempt) => attempt.outcome), [
      "error",
      "error",
      "error",
    ]);
  },
);

defineEvaluationTest("a successful retry replaces an Error", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const firstWork = await startRun(harness);
  const secondWork = await report(harness, firstWork.runId, [errorReport(firstWork.items[0])]);
  await report(harness, firstWork.runId, [outputReport(secondWork.items[0], "30 days")]);
  await harness.drainJobs();
  const run = await readRun(harness, firstWork.runId);
  assertEquals(run.verdict, "passed");
  assertEquals(run.testCases[0].iterations[0].attempts.map((attempt) => attempt.outcome), [
    "error",
    "passed",
  ]);
});

defineEvaluationTest("a regular expression that times out uses up an attempt", async (harness) => {
  await createDatasetWithTestCases(harness, [
    refundTestCase({
      evaluators: [{ type: "regex", name: "slow", pattern: "^(a+)+$", flags: "" }],
    }),
  ]);
  const firstWork = await startRun(harness);
  await report(harness, firstWork.runId, [outputReport(firstWork.items[0], `${"a".repeat(40)}!`)]);
  await harness.drainJobs();
  const secondWork = await expectJson<EvaluationRunWork>(
    sendRequest(harness, "GET", `/v1/evaluation-runs/${firstWork.runId}/work`),
    200,
  );
  assertEquals(secondWork.items.map((item) => item.attempt), [2]);
  assertEquals(secondWork.status, "running");
});

defineEvaluationTest("accepts a repeated report and refuses a different one", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase({ iterations: 2 })]);
  const work = await startRun(harness);
  const [firstItem, secondItem] = work.items;
  const firstReport = outputReport(firstItem, "30 days");
  await report(harness, work.runId, [firstReport]);
  assertEquals(harness.queuedJobs.length, 1);

  const repeated = await report(harness, work.runId, [firstReport, firstReport]);
  assertEquals(repeated.rejected, []);
  assertEquals(harness.queuedJobs.length, 1, "A repeated report must not queue another job.");

  const conflicting = await report(harness, work.runId, [outputReport(firstItem, "different")]);
  assertEquals(conflicting.rejected.map((rejected) => rejected.code), ["conflicting_report"]);

  const others = await report(harness, work.runId, [
    outputReport({ iterationId: "no-such-iteration", attempt: 1 }, "x"),
    outputReport({ iterationId: secondItem.iterationId, attempt: 2 }, "x"),
    outputReport(secondItem, "30 days"),
  ]);
  assertEquals(others.rejected.map((rejected) => rejected.code), [
    "unknown_iteration",
    "stale_attempt",
  ]);
  assertEquals(harness.queuedJobs.length, 2, "The valid report in the batch is still accepted.");
});

defineEvaluationTest("runs use the copy of a Test Case made when they started", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const work = await startRun(harness);
  const { name: _name, ...stricter } = refundTestCase({
    evaluators: [{ ...MENTIONS_DAYS_EVALUATOR, pattern: "never matches this" }],
  });
  await expectJson(
    sendRequest(harness, "PUT", "/v1/datasets/support-bot/test-cases/refund", { body: stricter }),
    200,
  );
  await report(harness, work.runId, [outputReport(work.items[0], "30 days")]);
  await harness.drainJobs();
  const run = await readRun(harness, work.runId);
  assertEquals(run.verdict, "passed");
  assertEquals(run.testCases[0].evaluators[0].pattern, "30\\s*days");
  assertEquals((await sendRequest(harness, "DELETE", "/v1/datasets/support-bot")).status, 204);
  assertEquals((await readRun(harness, work.runId)).verdict, "passed");
});

defineEvaluationTest(
  "finishing early ends unreported Iterations without retries",
  async (harness) => {
    await createDatasetWithTestCases(harness, [refundTestCase({ iterations: 2 })]);
    const work = await startRun(harness);
    await report(harness, work.runId, [outputReport(work.items[0], "30 days")]);

    const finishing = await expectJson<EvaluationRunWork>(
      sendRequest(harness, "POST", `/v1/evaluation-runs/${work.runId}/finish`),
      200,
    );
    assertEquals([finishing.status, finishing.items], ["running", []]);
    assertEquals(finishing.evaluationsInProgress, 1);
    const late = await report(harness, work.runId, [outputReport(work.items[1], "30 days")]);
    assertEquals(late.rejected.map((rejected) => rejected.code), ["run_ended"]);

    await harness.drainJobs();
    const run = await readRun(harness, work.runId);
    assertEquals(run.status, "finished");
    assertEquals(run.verdict, "error");
    assertEquals(run.testCases[0].iterations.map((iteration) => iteration.status), [
      "passed",
      "error",
    ]);
    assertEquals(run.testCases[0].iterations[1].attempts[0].error, NOT_REPORTED_ERROR);
  },
);

defineEvaluationTest("a finished run never changes", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const work = await startRun(harness);
  const passingReport = outputReport(work.items[0], "30 days");
  await report(harness, work.runId, [passingReport]);
  const job = harness.queuedJobs[0];
  await harness.drainJobs();
  const finishedRun = await readRun(harness, work.runId);
  assertEquals(finishedRun.verdict, "passed");

  await harness.worker.evaluateAttempt(job);
  const repeated = await report(harness, work.runId, [passingReport]);
  assertEquals(repeated.rejected, [], "Resending a lost batch must still succeed.");
  await expectJson(sendRequest(harness, "POST", `/v1/evaluation-runs/${work.runId}/finish`), 200);
  assertEquals(await readRun(harness, work.runId), finishedRun);
});

defineEvaluationTest("concurrent evaluations finish the run exactly once", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase({ iterations: 8 })]);
  const work = await startRun(harness);
  await report(harness, work.runId, work.items.map((item) => outputReport(item, "30 days")));
  const jobs = harness.queuedJobs.splice(0);
  await Promise.all([...jobs, ...jobs].map((job) => harness.worker.evaluateAttempt(job)));
  const run = await readRun(harness, work.runId);
  assertEquals([run.status, run.verdict, run.completedIterations], ["finished", "passed", 8]);
  assertEquals(
    run.testCases[0].iterations.flatMap((iteration) => iteration.attempts).length,
    8,
  );
});

defineEvaluationTest("maintenance queues a lost evaluation again", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const work = await startRun(harness);
  await report(harness, work.runId, [outputReport(work.items[0], "30 days")]);
  harness.queuedJobs.splice(0);

  await harness.worker.runMaintenance();
  assertEquals(harness.queuedJobs.length, 0, "A recent job is not lost yet.");

  harness.advanceClock(300_000);
  await harness.worker.runMaintenance();
  assertEquals(harness.queuedJobs.length, 1);
  await harness.drainJobs();
  assertEquals((await readRun(harness, work.runId)).verdict, "passed");
});

defineEvaluationTest("maintenance ends a run without activity", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase({ iterations: 2 })]);
  const work = await startRun(harness);
  await report(harness, work.runId, [outputReport(work.items[0], "30 days")]);
  harness.queuedJobs.splice(0);

  harness.advanceClock(INACTIVE_RUN_TIMEOUT_MILLISECONDS - 60_000);
  await harness.worker.runMaintenance();
  assertEquals((await readRun(harness, work.runId)).status, "running");

  harness.advanceClock(120_000);
  await harness.worker.runMaintenance();
  const run = await readRun(harness, work.runId);
  assertEquals([run.status, run.verdict], ["finished", "error"]);
  assertEquals(
    run.testCases[0].iterations.map((iteration) => iteration.attempts.at(-1)?.error),
    [NOT_EVALUATED_ERROR, NOT_REPORTED_ERROR],
  );
});

defineEvaluationTest("lists runs newest first and filters by Dataset", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase({ iterations: 2 })]);
  const firstWork = await startRun(harness);
  await report(harness, firstWork.runId, [errorReport(firstWork.items[0])]);
  const secondWork = await startRun(harness);
  const { evaluationRuns } = await expectJson<ListEvaluationRunsResponse>(
    sendRequest(harness, "GET", "/v1/evaluation-runs?datasetName=support-bot"),
    200,
  );
  assertEquals(evaluationRuns.map((run) => run.id), [secondWork.runId, firstWork.runId]);
  assertEquals(evaluationRuns.map((run) => run.totalIterations), [2, 2]);
  const other = await expectJson<ListEvaluationRunsResponse>(
    sendRequest(harness, "GET", "/v1/evaluation-runs?datasetName=other"),
    200,
  );
  assertEquals(other.evaluationRuns, []);
});

defineEvaluationTest("pages through a run's results without gaps", async (harness) => {
  await createDatasetWithTestCases(harness, [
    refundTestCase({ name: "case-a", iterations: 5 }),
    refundTestCase({ name: "case-b" }),
    refundTestCase({ name: "case-c" }),
  ]);
  const { runId } = await startRun(harness);
  const runPath = `/v1/evaluation-runs/${runId}`;
  const firstPage = await expectJson<ListTestCaseResultsResponse>(
    sendRequest(harness, "GET", `${runPath}/test-cases?limit=2`),
    200,
  );
  assertEquals(firstPage.testCases.map((testCase) => testCase.name), ["case-a", "case-b"]);
  assertEquals(firstPage.testCases[0].totalIterations, 5);
  assert(firstPage.nextCursor !== null);
  const lastPage = await expectJson<ListTestCaseResultsResponse>(
    sendRequest(harness, "GET", `${runPath}/test-cases?limit=2&cursor=${firstPage.nextCursor}`),
    200,
  );
  assertEquals(lastPage.testCases.map((testCase) => testCase.name), ["case-c"]);
  assertEquals(lastPage.nextCursor, null);

  const iterationsPath = `${runPath}/test-cases/case-a/iterations`;
  const iterationPage = await expectJson<ListIterationResultsResponse>(
    sendRequest(harness, "GET", `${iterationsPath}?limit=2&cursor=2`),
    200,
  );
  assertEquals(iterationPage.iterations.map((iteration) => iteration.iterationNumber), [3, 4]);
  assertEquals(iterationPage.nextCursor, 4);

  await expectJson(sendRequest(harness, "GET", `${runPath}/test-cases?limit=51`), 400);
  await expectJson(sendRequest(harness, "GET", `${runPath}/test-cases/nope/iterations`), 404);
  await expectJson(
    sendRequest(harness, "GET", `${runPath}/test-cases`, { bearerToken: OTHER_PROJECT_API_KEY }),
    404,
  );
  await expectJson(
    sendRequest(harness, "GET", iterationsPath, { bearerToken: OTHER_PROJECT_API_KEY }),
    404,
  );
});
