import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  Dataset,
  EvaluationRunWork,
  Evaluator,
  ListDatasetsResponse,
  ListEvaluationRunsResponse,
  ListIterationResultsResponse,
  ListTestCaseResultsResponse,
  ListTestCasesResponse,
  Span,
  TestCase,
} from "@extispex/contracts";
import {
  NOT_EVALUATED_ERROR,
  NOT_REPORTED_ERROR,
} from "../src/storage/evaluation-run-repository.ts";
import {
  createDatasetWithTestCases,
  defineEvaluationTest,
  errorReport,
  expectJson,
  INACTIVE_RUN_TIMEOUT_MILLISECONDS,
  MENTIONS_DAYS_EVALUATOR,
  OTHER_PROJECT_API_KEY,
  outputReport,
  readRun,
  refundTestCase,
  report,
  sendRequest,
  startRun,
  testAccessTokens,
  TestHarness,
} from "./evaluation-test-harness.ts";

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
  assertEquals(
    stored.evaluators[0],
    { ...MENTIONS_DAYS_EVALUATOR, expectMatch: true } as Evaluator,
  );

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
  assertEquals(run.testCases[0].evaluators[0].name, MENTIONS_DAYS_EVALUATOR.name);
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

  await harness.worker.handleJob(job);
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
  await Promise.all([...jobs, ...jobs].map((job) => harness.worker.handleJob(job)));
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

const CALLED_TOOL_EVALUATOR = {
  type: "telemetry",
  name: "called-lookup",
  match: { name: "execute_tool", attributes: { "gen_ai.tool.name": "lookup_refund" } },
};

function createSpan(overrides: Partial<Span> = {}): Span {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    parentSpanId: "root-span",
    name: "execute_tool",
    kind: "internal",
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    durationMilliseconds: 12,
    statusCode: "ok",
    statusMessage: null,
    serviceName: "support-bot",
    correlationId: "correlation",
    sessionId: null,
    attributes: { "gen_ai.tool.name": "lookup_refund", "other.attribute": "not copied" },
    resourceAttributes: {},
    receivedAt: "2026-11-08T10:00:00.000Z",
    arrivedAfterEvaluation: false,
    ...overrides,
  };
}

/** A run of one Test Case with a Telemetry Evaluator; its first Iteration is reported. */
async function startTelemetryRun(
  harness: TestHarness,
  testCaseOverrides: Record<string, unknown> = {},
) {
  await createDatasetWithTestCases(harness, [
    refundTestCase({ evaluators: [CALLED_TOOL_EVALUATOR], ...testCaseOverrides }),
  ]);
  return await startRun(harness);
}

/** Telemetry that has its root span, stored now. */
function storeCompleteTrace(harness: TestHarness, correlationId: string, spans = [createSpan()]) {
  const storedAt = harness.readClock().toISOString();
  harness.telemetry.correlations.set(correlationId, {
    firstReceivedAt: storedAt,
    traces: [{ traceId: "trace-1", rootSpanStoredAt: storedAt }],
  });
  harness.telemetry.spans.set(correlationId, spans);
}

function readAttempts(run: Awaited<ReturnType<typeof readRun>>) {
  return run.testCases[0].iterations[0].attempts;
}

defineEvaluationTest(
  "judges spans once the root span has been stored long enough",
  async (harness) => {
    const work = await startTelemetryRun(harness);
    const correlationId = "correlation-settled";
    await report(harness, work.runId, [{ ...outputReport(work.items[0], "x"), correlationId }]);

    // No telemetry yet: the job comes back later, and the attempt stays open.
    await harness.drainJobs();
    assertEquals(harness.queuedJobs.length, 1);
    assertEquals(readAttempts(await readRun(harness, work.runId))[0].outcome, null);

    // The root span is there, but other services may still be sending theirs.
    storeCompleteTrace(harness, correlationId);
    await harness.drainJobs();
    assertEquals(harness.queuedJobs.length, 1);
    assertEquals(harness.telemetry.evaluatedAt.size, 0);

    harness.advanceClock(10_000);
    await harness.drainJobs();
    assertEquals(harness.queuedJobs.length, 0);
    const run = await readRun(harness, work.runId);
    assertEquals(run.verdict, "passed");
    const [evaluatorResult] = readAttempts(run)[0].evaluatorResults;
    assertEquals(evaluatorResult.type, "telemetry");
    assertEquals(evaluatorResult.outcome, "passed");
    assertEquals(evaluatorResult.matchedSpanCount, 1);
    // The summary keeps what the Evaluator tested, so it stays readable after retention expires.
    assertEquals(evaluatorResult.matchedSpans?.[0], {
      traceId: "trace-1",
      spanId: "span-1",
      name: "execute_tool",
      statusCode: "ok",
      durationMilliseconds: 12,
      serviceName: "support-bot",
      attributes: { "gen_ai.tool.name": "lookup_refund" },
    });
    assert(harness.telemetry.evaluatedAt.has(correlationId));
  },
);

defineEvaluationTest("fails when the spans do not match", async (harness) => {
  const work = await startTelemetryRun(harness);
  const correlationId = "correlation-other-tool";
  await report(harness, work.runId, [{ ...outputReport(work.items[0], "x"), correlationId }]);
  storeCompleteTrace(harness, correlationId, [
    createSpan({ attributes: { "gen_ai.tool.name": "other" } }),
  ]);
  harness.advanceClock(11_000);
  await harness.drainJobs();
  const run = await readRun(harness, work.runId);
  assertEquals(run.verdict, "failed");
  const [evaluatorResult] = readAttempts(run)[0].evaluatorResults;
  assertEquals(evaluatorResult.matchedSpanCount, 0);
  assertStringIncludes(evaluatorResult.reason, "expected at least 1");
});

defineEvaluationTest(
  "runs the other Evaluators after the telemetry is complete",
  async (harness) => {
    const work = await startTelemetryRun(harness, {
      evaluators: [MENTIONS_DAYS_EVALUATOR, CALLED_TOOL_EVALUATOR],
    });
    const correlationId = "correlation-both";
    await report(harness, work.runId, [{
      ...outputReport(work.items[0], "30 days"),
      correlationId,
    }]);
    storeCompleteTrace(harness, correlationId);
    harness.advanceClock(11_000);
    await harness.drainJobs();
    const run = await readRun(harness, work.runId);
    assertEquals(readAttempts(run)[0].evaluatorResults.map((result) => result.outcome), [
      "passed",
      "passed",
    ]);
  },
);

defineEvaluationTest(
  "ends an attempt as Error when no root span arrives in time",
  async (harness) => {
    const work = await startTelemetryRun(harness, { iterations: 1 });
    const [item] = work.items;
    const correlationId = "correlation-no-root";
    await report(harness, work.runId, [{ ...outputReport(item, "x"), correlationId }]);
    harness.telemetry.correlations.set(correlationId, {
      firstReceivedAt: harness.readClock().toISOString(),
      traces: [{ traceId: "trace-1", rootSpanStoredAt: null }],
    });
    harness.advanceClock(50_000);
    await harness.drainJobs();
    assertEquals(harness.queuedJobs.length, 1);
    harness.advanceClock(10_000);
    await harness.drainJobs();

    const [attempt] = readAttempts(await readRun(harness, work.runId));
    assertEquals(attempt.outcome, "error");
    assertStringIncludes(attempt.error ?? "", "No root span arrived within 60 s");
    assertEquals(harness.telemetry.evaluatedAt.size, 0);
    // An Error gets another attempt, which must use new IDs.
    const nextWork = await expectJson<EvaluationRunWork>(
      sendRequest(harness, "GET", `/v1/evaluation-runs/${work.runId}/work`),
      200,
    );
    assertEquals(nextWork.items.map((workItem) => workItem.attempt), [2]);
  },
);

defineEvaluationTest("reports when no telemetry arrived at all", async (harness) => {
  const work = await startTelemetryRun(harness);
  await report(harness, work.runId, [outputReport(work.items[0], "x")]);
  harness.advanceClock(61_000);
  await harness.drainJobs();
  assertStringIncludes(
    readAttempts(await readRun(harness, work.runId))[0].error ?? "",
    "No telemetry for this Correlation ID",
  );
});

defineEvaluationTest("rejects telemetry received before the attempt started", async (harness) => {
  const earlier = new Date(harness.readClock().getTime() - 5_000).toISOString();
  const work = await startTelemetryRun(harness);
  const correlationId = "correlation-reused";
  harness.telemetry.correlations.set(correlationId, { firstReceivedAt: earlier, traces: [] });
  await report(harness, work.runId, [{ ...outputReport(work.items[0], "x"), correlationId }]);
  await harness.drainJobs();
  const [attempt] = readAttempts(await readRun(harness, work.runId));
  assertEquals(attempt.outcome, "error");
  assertStringIncludes(attempt.error ?? "", "already had telemetry");
  assertEquals(harness.queuedJobs.length, 0);
});

defineEvaluationTest("rejects a Session that already had telemetry", async (harness) => {
  const earlier = new Date(harness.readClock().getTime() - 5_000).toISOString();
  const work = await startTelemetryRun(harness);
  const correlationId = "correlation-new";
  harness.telemetry.firstReceivedAtBySession.set("chat-reused", earlier);
  storeCompleteTrace(harness, correlationId);
  await report(harness, work.runId, [{
    ...outputReport(work.items[0], "x"),
    correlationId,
    sessionId: "chat-reused",
  }]);
  await harness.drainJobs();
  assertStringIncludes(
    readAttempts(await readRun(harness, work.runId))[0].error ?? "",
    "This session.id already had telemetry",
  );
});

defineEvaluationTest(
  "rejects a Correlation ID used by another Iteration of the run",
  async (harness) => {
    const work = await startTelemetryRun(harness, { iterations: 2 });
    const correlationId = "correlation-shared";
    storeCompleteTrace(harness, correlationId);
    await report(
      harness,
      work.runId,
      work.items.map((item) => ({ ...outputReport(item, "x"), correlationId })),
    );
    harness.advanceClock(11_000);
    await harness.drainJobs();
    const run = await readRun(harness, work.runId);
    for (const iteration of run.testCases[0].iterations) {
      assertEquals(iteration.attempts[0].outcome, "error");
      assertStringIncludes(iteration.attempts[0].error ?? "", "also used by Test Case refund");
    }
  },
);

defineEvaluationTest("rejects a Session used by another Iteration of the run", async (harness) => {
  const work = await startTelemetryRun(harness, { iterations: 2 });
  await report(
    harness,
    work.runId,
    work.items.map((item) => ({ ...outputReport(item, "x"), sessionId: "chat-shared" })),
  );
  await harness.drainJobs();
  const run = await readRun(harness, work.runId);
  assertStringIncludes(
    run.testCases[0].iterations[0].attempts[0].error ?? "",
    "This session.id is also used",
  );
});

defineEvaluationTest("expects new IDs from a retried attempt", async (harness) => {
  const work = await startTelemetryRun(harness);
  const [item] = work.items;
  const correlationId = "correlation-retried";
  await report(harness, work.runId, [{ ...errorReport(item), correlationId }]);
  await report(harness, work.runId, [{
    ...outputReport({ ...item, attempt: 2 }, "x"),
    correlationId,
  }]);
  storeCompleteTrace(harness, correlationId);
  await harness.drainJobs();
  assertStringIncludes(
    readAttempts(await readRun(harness, work.runId))[1].error ?? "",
    "also used by Test Case refund, Iteration 1, attempt 1",
  );
});

defineEvaluationTest("waits out a Telemetry outage until the timeout", async (harness) => {
  const work = await startTelemetryRun(harness);
  const correlationId = "correlation-outage";
  await report(harness, work.runId, [{ ...outputReport(work.items[0], "x"), correlationId }]);
  storeCompleteTrace(harness, correlationId);
  harness.telemetry.isUnavailable = true;
  harness.advanceClock(11_000);
  await harness.drainJobs();
  assertEquals(harness.queuedJobs.length, 1);
  assertEquals(readAttempts(await readRun(harness, work.runId))[0].outcome, null);

  harness.advanceClock(60_000);
  await harness.drainJobs();
  assertStringIncludes(
    readAttempts(await readRun(harness, work.runId))[0].error ?? "",
    "could not be read in time",
  );
});

defineEvaluationTest("keeps a waiting job from counting as stalled", async (harness) => {
  const work = await startTelemetryRun(harness);
  await report(harness, work.runId, [outputReport(work.items[0], "x")]);
  await harness.drainJobs();
  assertEquals(harness.queuedJobs.length, 1);
  harness.advanceClock(100_000);
  await harness.worker.runMaintenance();
  assertEquals(harness.queuedJobs.length, 1);
});

defineEvaluationTest("judges an Output at once when no Evaluator reads spans", async (harness) => {
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const work = await startRun(harness);
  await report(harness, work.runId, [outputReport(work.items[0], "30 days")]);
  await harness.drainJobs();
  assertEquals((await readRun(harness, work.runId)).verdict, "passed");
  assertEquals(harness.telemetry.requestCount, 0);
});

defineEvaluationTest("refuses an invalid Telemetry Evaluator", async (harness) => {
  await expectJson(
    sendRequest(harness, "POST", "/v1/datasets", { body: { name: "support-bot" } }),
    201,
  );
  for (
    const invalidEvaluator of [
      { type: "telemetry", name: "no-condition", match: {} },
      { type: "telemetry", name: "misspelt", match: { nam: "execute_tool" } },
      { ...CALLED_TOOL_EVALUATOR, count: { min: 0 } },
      { ...CALLED_TOOL_EVALUATOR, count: { min: 3, max: 2 } },
    ]
  ) {
    await expectJson(
      sendRequest(harness, "POST", "/v1/datasets/support-bot/test-cases", {
        body: refundTestCase({ evaluators: [invalidEvaluator] }),
      }),
      400,
    );
  }
  const stored = await expectJson<TestCase>(
    sendRequest(harness, "POST", "/v1/datasets/support-bot/test-cases", {
      body: refundTestCase({ evaluators: [CALLED_TOOL_EVALUATOR] }),
    }),
    201,
  );
  // The default asks for at least one matching span.
  assertEquals(stored.evaluators[0], { ...CALLED_TOOL_EVALUATOR, count: { min: 1 } } as Evaluator);
});

defineEvaluationTest(
  "removes a deleted Project's Datasets, runs and Targets, and keeps other Projects'",
  async (harness) => {
    await createDatasetWithTestCases(harness, [refundTestCase()]);
    const work = await startRun(harness);
    await report(harness, work.runId, [outputReport(work.items[0], "Within 30 days.")]);
    await harness.drainJobs();
    await expectJson(
      sendRequest(harness, "POST", "/v1/targets", {
        body: { name: "support-bot", url: harness.target.url },
      }),
      201,
    );
    await expectJson(
      sendRequest(harness, "POST", "/v1/datasets", {
        bearerToken: OTHER_PROJECT_API_KEY,
        body: { name: "kept" },
      }),
      201,
    );

    harness.projectLifecycle.lifecycle = {
      projects: [{ projectId: "project-two", retentionDays: 30 }],
      projectsToRemove: [{
        projectId: "project-one",
        deletedAt: harness.readClock().toISOString(),
      }],
    };
    assertEquals(await harness.worker.runDataLifecycle(), {
      status: "ran",
      removedProjectIds: ["project-one"],
    });
    assertEquals(harness.projectLifecycle.recordedRemovals, ["project-one"]);
    for (
      const tableName of [
        "iteration_attempt_steps",
        "iteration_attempts",
        "iterations",
        "run_test_cases",
        "evaluation_runs",
        "test_cases",
        "targets",
      ]
    ) {
      const rows = await harness.database.orm.em.fork().execute<{ row_count: number | string }[]>(
        `select count(*) as row_count from ${tableName}`,
      );
      assertEquals(Number(rows[0].row_count), 0, tableName);
    }
    const { datasets } = await expectJson<ListDatasetsResponse>(
      sendRequest(harness, "GET", "/v1/datasets", { bearerToken: OTHER_PROJECT_API_KEY }),
      200,
    );
    assertEquals(datasets.map((dataset) => dataset.name), ["kept"]);
    // A job of the removed run that is still queued finds nothing and ends.
    await harness.worker.handleJob({ iterationId: work.items[0].iterationId, attemptNumber: 1 });
  },
);
