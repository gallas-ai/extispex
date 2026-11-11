/** Targets, Server-Driven Execution and Session Test Cases in both execution modes. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  EvaluationRunWork,
  IterationReport,
  ListTargetsResponse,
  ReportIterationsResponse,
  Span,
  Target,
  TestCase,
} from "@extispex/contracts";
import { NOT_EXECUTED_ERROR } from "../src/storage/evaluation-run-repository.ts";
import {
  answerLikeAnApplication,
  createDatasetWithTestCases,
  defineEvaluationTest,
  expectJson,
  MENTIONS_DAYS_EVALUATOR,
  readRun,
  refundTestCase,
  report,
  sendRequest,
  startRun,
  testAccessTokens,
  type TestHarness,
} from "./evaluation-test-harness.ts";

const TARGET_CREDENTIAL = { headerName: "Authorization", headerValue: "Bearer target-secret" };

function createTarget(harness: TestHarness, overrides: Record<string, unknown> = {}) {
  return expectJson<Target>(
    sendRequest(harness, "POST", "/v1/targets", {
      body: {
        name: "support-bot",
        url: harness.target.url,
        credential: TARGET_CREDENTIAL,
        ...overrides,
      },
    }),
    201,
  );
}

function startServerRun(harness: TestHarness, targetName = "support-bot") {
  return expectJson<EvaluationRunWork>(
    sendRequest(harness, "POST", "/v1/evaluation-runs", {
      body: { datasetName: "support-bot", executionMode: "server", targetName },
    }),
    201,
  );
}

function sessionTestCase(overrides: Record<string, unknown> = {}) {
  return {
    name: "cancel-order",
    scope: "session",
    steps: [
      { input: { message: "Where is my order?" } },
      { input: { message: "Can I cancel it?" } },
    ],
    evaluators: [MENTIONS_DAYS_EVALUATOR],
    ...overrides,
  };
}

function readFirstIteration(run: Awaited<ReturnType<typeof readRun>>) {
  return run.testCases[0].iterations[0];
}

defineEvaluationTest("keeps a Target's credential out of every answer", async (harness) => {
  const created = await createTarget(harness, { description: " The support bot " });
  assertEquals(created, {
    name: "support-bot",
    url: harness.target.url,
    description: "The support bot",
    credentialHeaderName: "Authorization",
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  });
  const listed = await expectJson<ListTargetsResponse>(
    sendRequest(harness, "GET", "/v1/targets"),
    200,
  );
  assertEquals(listed.targets, [created]);
  assert(!JSON.stringify(listed).includes("target-secret"));

  // Only the sealed value reaches the database.
  const [storedRow] = await harness.database.orm.em.fork().execute<
    { sealed_credential_value: string }[]
  >("select sealed_credential_value from targets");
  assert(!storedRow.sealed_credential_value.includes("target-secret"));

  // Leaving the credential out keeps it, and null removes it.
  const kept = await expectJson<Target>(
    sendRequest(harness, "PUT", "/v1/targets/support-bot", {
      body: { url: `${harness.target.url}?v=2` },
    }),
    200,
  );
  assertEquals([kept.url, kept.credentialHeaderName], [
    `${harness.target.url}?v=2`,
    "Authorization",
  ]);
  const cleared = await expectJson<Target>(
    sendRequest(harness, "PUT", "/v1/targets/support-bot", {
      body: { url: harness.target.url, credential: null },
    }),
    200,
  );
  assertEquals(cleared.credentialHeaderName, null);

  await expectJson(sendRequest(harness, "DELETE", "/v1/targets/support-bot"), 204);
  await expectJson(sendRequest(harness, "GET", "/v1/targets/support-bot"), 404);
});

defineEvaluationTest("refuses invalid Targets and changes by a viewer", async (harness) => {
  await createTarget(harness);
  await expectJson(
    sendRequest(harness, "POST", "/v1/targets", {
      body: { name: "support-bot", url: harness.target.url },
    }),
    409,
  );
  for (
    const invalidBody of [
      { name: "ftp", url: "ftp://agent.example/" },
      { name: "user-info", url: "https://user:password@agent.example/" },
      {
        name: "host-header",
        url: "https://agent.example/",
        credential: { headerName: "Host", headerValue: "x" },
      },
      {
        name: "line-break",
        url: "https://agent.example/",
        credential: { headerName: "X-Key", headerValue: "a\r\nX-Injected: 1" },
      },
    ]
  ) {
    await expectJson(sendRequest(harness, "POST", "/v1/targets", { body: invalidBody }), 400);
  }
  const viewerToken = await testAccessTokens.issueAccessToken({
    projectId: "project-one",
    role: "viewer",
  });
  await expectJson(
    sendRequest(harness, "GET", "/v1/targets", { bearerToken: viewerToken }),
    200,
  );
  await expectJson(
    sendRequest(harness, "DELETE", "/v1/targets/support-bot", { bearerToken: viewerToken }),
    403,
  );
});

defineEvaluationTest(
  "calls the Target for each Iteration and judges its Output",
  async (harness) => {
    await createTarget(harness);
    await createDatasetWithTestCases(harness, [refundTestCase({ iterations: 2 })]);
    const work = await startServerRun(harness);
    assertEquals([work.status, work.items, work.evaluationsInProgress], ["running", [], 2]);
    assertEquals(harness.queuedJobs.map((job) => job.kind), ["execute", "execute"]);

    await harness.drainJobsUntilIdle();
    const run = await readRun(harness, work.runId);
    assertEquals([run.executionMode, run.targetName, run.status, run.verdict], [
      "server",
      "support-bot",
      "finished",
      "passed",
    ]);
    assertEquals(harness.target.requests.length, 2);
    for (const { body, headers } of harness.target.requests) {
      assertEquals(body, { input: { message: "What is your refund policy?" }, sessionId: null });
      assertEquals(headers.get("authorization"), "Bearer target-secret");
    }
    const attempt = readFirstIteration(run).attempts[0];
    assertEquals(attempt.correlationId, "target-correlation-1");
    assertEquals(attempt.transcript, null);
  },
);

defineEvaluationTest("calls the Target once when its job is delivered twice", async (harness) => {
  await createTarget(harness);
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  await startServerRun(harness);
  const [job] = harness.queuedJobs.splice(0);
  await Promise.all([harness.worker.handleJob(job), harness.worker.handleJob(job)]);
  assertEquals(harness.target.requests.length, 1);
  await harness.worker.handleJob(job);
  assertEquals(harness.target.requests.length, 1);
});

defineEvaluationTest(
  "retries a failing Target and ends the Iteration as Error",
  async (harness) => {
    await createTarget(harness);
    await createDatasetWithTestCases(harness, [refundTestCase()]);
    harness.target.answer = () => new Response("Internal error", { status: 500 });
    const work = await startServerRun(harness);
    await harness.drainJobsUntilIdle();
    const run = await readRun(harness, work.runId);
    assertEquals([run.status, run.verdict], ["finished", "error"]);
    const attempts = readFirstIteration(run).attempts;
    assertEquals(attempts.map((attempt) => attempt.outcome), ["error", "error", "error"]);
    assertEquals(attempts[0].error, "The Target answered with status 500.");
    assertEquals(harness.target.requests.length, 3);
  },
);

defineEvaluationTest("a later attempt can pass after the Target failed", async (harness) => {
  await createTarget(harness);
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  harness.target.answer = (body, callNumber) =>
    callNumber === 1
      ? new Response(null, { status: 503 })
      : answerLikeAnApplication(body, callNumber);
  const work = await startServerRun(harness);
  await harness.drainJobsUntilIdle();
  const run = await readRun(harness, work.runId);
  assertEquals(run.verdict, "passed");
  assertEquals(readFirstIteration(run).attempts.map((attempt) => attempt.outcome), [
    "error",
    "passed",
  ]);
});

defineEvaluationTest("never calls a Target outside the allowlist", async (harness) => {
  await createTarget(harness, { url: "http://10.255.255.1/evaluate" });
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const work = await startServerRun(harness);
  await harness.drainJobsUntilIdle();
  const attempts = readFirstIteration(await readRun(harness, work.runId)).attempts;
  assertStringIncludes(attempts[0].error ?? "", "EVALUATION_TARGET_ALLOWED_DESTINATIONS");
  assertEquals(harness.target.requests.length, 0);
});

defineEvaluationTest("ends attempts as Error when the Target was deleted", async (harness) => {
  await createTarget(harness);
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  const work = await startServerRun(harness);
  await expectJson(sendRequest(harness, "DELETE", "/v1/targets/support-bot"), 204);
  await harness.drainJobsUntilIdle();
  const run = await readRun(harness, work.runId);
  assertEquals(run.targetName, "support-bot");
  assertStringIncludes(readFirstIteration(run).attempts[0].error ?? "", "no longer exists");
});

defineEvaluationTest(
  "refuses a server run without a known Target, and reports to it",
  async (harness) => {
    await createDatasetWithTestCases(harness, [refundTestCase()]);
    await expectJson(
      sendRequest(harness, "POST", "/v1/evaluation-runs", {
        body: { datasetName: "support-bot", executionMode: "server", targetName: "missing" },
      }),
      404,
    );
    await expectJson(
      sendRequest(harness, "POST", "/v1/evaluation-runs", {
        body: { datasetName: "support-bot", executionMode: "server" },
      }),
      400,
    );
    await createTarget(harness);
    const work = await startServerRun(harness);
    const iterationId = harness.queuedJobs[0].iterationId;
    const response = await report(harness, work.runId, [{
      iterationId,
      attempt: 1,
      output: "From a script",
      correlationId: "script-correlation",
    }]);
    assertEquals(response.rejected.map((rejected) => rejected.code), ["server_driven_run"]);
  },
);

defineEvaluationTest(
  "finishing a server run ends the Iterations not yet called",
  async (harness) => {
    await createTarget(harness);
    await createDatasetWithTestCases(harness, [refundTestCase({ iterations: 2 })]);
    const work = await startServerRun(harness);
    await expectJson(sendRequest(harness, "POST", `/v1/evaluation-runs/${work.runId}/finish`), 200);
    // A job that is delivered afterwards does nothing.
    await harness.drainJobsUntilIdle();
    const run = await readRun(harness, work.runId);
    assertEquals([run.status, run.verdict], ["finished", "error"]);
    assertEquals(readFirstIteration(run).attempts[0].error, NOT_EXECUTED_ERROR);
    assertEquals(harness.target.requests.length, 0);
  },
);

defineEvaluationTest("maintenance gives an abandoned call to another worker", async (harness) => {
  await createTarget(harness);
  await createDatasetWithTestCases(harness, [refundTestCase()]);
  await startServerRun(harness);
  const [job] = harness.queuedJobs.splice(0);
  // A worker took the attempt and died before it stored anything.
  const claimed = await harness.database.orm.em.fork().execute(
    "update iterations set execution_heartbeat_at = evaluation_requested_at",
  );
  assert(claimed !== undefined);
  await harness.worker.handleJob(job);
  assertEquals(harness.target.requests.length, 0, "A live claim keeps another worker out.");
  harness.advanceClock(130_000);
  await harness.worker.runMaintenance();
  assertEquals(harness.queuedJobs.map((queued) => queued.kind), ["execute"]);
  await harness.drainJobsUntilIdle();
  assertEquals(harness.target.requests.length, 1);
});

defineEvaluationTest("validates Session Test Cases", async (harness) => {
  await expectJson(
    sendRequest(harness, "POST", "/v1/datasets", { body: { name: "support-bot" } }),
    201,
  );
  const path = "/v1/datasets/support-bot/test-cases";
  for (
    const invalidTestCase of [
      sessionTestCase({ steps: undefined }),
      sessionTestCase({ steps: [] }),
      sessionTestCase({ input: { message: "Not here" } }),
      refundTestCase({ steps: [{ input: "x" }] }),
      refundTestCase({ evaluators: [{ ...MENTIONS_DAYS_EVALUATOR, step: 1 }] }),
      sessionTestCase({ evaluators: [{ ...MENTIONS_DAYS_EVALUATOR, step: 3 }] }),
      sessionTestCase({ steps: [{}] }),
    ]
  ) {
    await expectJson(sendRequest(harness, "POST", path, { body: invalidTestCase }), 400);
  }
  const stored = await expectJson<TestCase>(
    sendRequest(harness, "POST", path, { body: sessionTestCase() }),
    201,
  );
  assertEquals([stored.scope, stored.steps?.length, stored.input], ["session", 2, undefined]);
});

defineEvaluationTest("runs a Session's steps in order within one Session", async (harness) => {
  await createTarget(harness);
  await createDatasetWithTestCases(harness, [sessionTestCase({
    evaluators: [
      { type: "regex", name: "first-step", pattern: "Where is my order", step: 1 },
      { type: "regex", name: "last-step", pattern: "Can I cancel it" },
    ],
  })]);
  const work = await startServerRun(harness);
  await harness.drainJobsUntilIdle();
  assertEquals(harness.target.requests.map(({ body }) => body), [
    { input: { message: "Where is my order?" }, sessionId: null },
    { input: { message: "Can I cancel it?" }, sessionId: "target-session-1" },
  ]);
  const run = await readRun(harness, work.runId);
  assertEquals(run.verdict, "passed");
  const attempt = readFirstIteration(run).attempts[0];
  assertEquals(attempt.evaluatorResults.map((result) => result.reason), [
    "The Output of step 1 matches /Where is my order/.",
    "The Output matches /Can I cancel it/.",
  ]);
  assertEquals(
    attempt.transcript?.map((step) => [step.stepNumber, step.input, step.correlationId]),
    [
      [1, { message: "Where is my order?" }, "target-correlation-1"],
      [2, { message: "Can I cancel it?" }, "target-correlation-2"],
    ],
  );
  assertEquals([attempt.correlationId, attempt.sessionId], [
    "target-correlation-2",
    "target-session-1",
  ]);
  assertEquals(run.testCases[0].steps?.length, 2);
});

defineEvaluationTest("ends a Session whose Target loses the session.id", async (harness) => {
  await createTarget(harness);
  await createDatasetWithTestCases(harness, [sessionTestCase()]);
  harness.target.answer = (body, callNumber) =>
    callNumber % 2 === 0
      ? Response.json({ output: "No session", correlationId: `c-${callNumber}` })
      : answerLikeAnApplication(body, callNumber);
  const work = await startServerRun(harness);
  await harness.drainJobsUntilIdle();
  const attempt = readFirstIteration(await readRun(harness, work.runId)).attempts[0];
  assertEquals(
    attempt.error,
    "Step 2: A Session Test Case needs a sessionId in the Target's answer.",
  );
  // The step that worked stays in the Transcript.
  assertEquals(attempt.transcript?.map((step) => step.stepNumber), [1]);
});

function sessionSpan(
  sessionId: string,
  correlationId: string,
  overrides: Partial<Span> = {},
): Span {
  return {
    traceId: `trace-${correlationId}`,
    spanId: `span-${correlationId}`,
    parentSpanId: "root-span",
    name: "execute_tool",
    kind: "internal",
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    durationMilliseconds: 12,
    statusCode: "ok",
    statusMessage: null,
    serviceName: "support-bot",
    correlationId,
    sessionId,
    attributes: { "gen_ai.tool.name": "cancel_order" },
    resourceAttributes: {},
    receivedAt: "2026-11-08T10:00:00.000Z",
    arrivedAfterEvaluation: false,
    ...overrides,
  };
}

defineEvaluationTest("judges the spans of a whole Session", async (harness) => {
  await createTarget(harness);
  await createDatasetWithTestCases(harness, [sessionTestCase({
    evaluators: [{
      type: "telemetry",
      name: "cancelled",
      match: { name: "execute_tool", attributes: { "gen_ai.tool.name": "cancel_order" } },
    }],
  })]);
  const work = await startServerRun(harness);
  await harness.drainJobs();
  // Both steps were called; their telemetry arrives now.
  const storedAt = harness.readClock().toISOString();
  for (const correlationId of ["target-correlation-1", "target-correlation-2"]) {
    harness.telemetry.correlations.set(correlationId, {
      firstReceivedAt: storedAt,
      traces: [{ traceId: `trace-${correlationId}`, rootSpanStoredAt: storedAt }],
    });
  }
  harness.telemetry.firstReceivedAtBySession.set("target-session-1", storedAt);
  // The tool was called in the first step, so only the whole Session shows it.
  harness.telemetry.sessionSpans.set("target-session-1", [
    sessionSpan("target-session-1", "target-correlation-1"),
    sessionSpan("target-session-1", "target-correlation-2", {
      attributes: { "gen_ai.tool.name": "lookup_order" },
    }),
  ]);
  await harness.drainJobs();
  assertEquals(harness.queuedJobs.length, 1, "The traces must settle first.");
  harness.advanceClock(11_000);
  await harness.drainJobsUntilIdle();
  const run = await readRun(harness, work.runId);
  assertEquals(run.verdict, "passed");
  const [result] = readFirstIteration(run).attempts[0].evaluatorResults;
  assertEquals(result.matchedSpanCount, 1);
  assertEquals(result.matchedSpans?.[0].traceId, "trace-target-correlation-1");
  assertEquals([...harness.telemetry.evaluatedAt.keys()].sort(), [
    "target-correlation-1",
    "target-correlation-2",
  ]);
});

defineEvaluationTest("waits for every step's trace of a Session", async (harness) => {
  await createDatasetWithTestCases(harness, [sessionTestCase({
    evaluators: [{ type: "telemetry", name: "cancelled", match: { name: "execute_tool" } }],
  })]);
  const work = await startRun(harness);
  const steps = [
    { output: "It ships today.", correlationId: "c-1", sessionId: "chat-1" },
    { output: "Cancelled.", correlationId: "c-2", sessionId: "chat-1" },
  ];
  await report(harness, work.runId, [{
    iterationId: work.items[0].iterationId,
    attempt: 1,
    steps,
  }]);
  const storedAt = harness.readClock().toISOString();
  harness.telemetry.correlations.set("c-1", {
    firstReceivedAt: storedAt,
    traces: [{ traceId: "trace-1", rootSpanStoredAt: storedAt }],
  });
  harness.advanceClock(61_000);
  await harness.drainJobsUntilIdle();
  const attempt = readFirstIteration(await readRun(harness, work.runId)).attempts[0];
  assertStringIncludes(attempt.error ?? "", "No telemetry for this Correlation ID arrived");
});

defineEvaluationTest("accepts a Session's steps from a script", async (harness) => {
  await createDatasetWithTestCases(harness, [sessionTestCase()]);
  const work = await startRun(harness);
  const [item] = work.items;
  assertEquals([item.scope, item.input, item.steps?.length], ["session", null, 2]);
  const steps = [
    { output: "It ships today.", correlationId: "c-1", sessionId: "chat-1" },
    { output: "Within 30 days, yes.", correlationId: "c-2", sessionId: "chat-1" },
  ];
  const sessionReport: IterationReport = { iterationId: item.iterationId, attempt: 1, steps };
  const invalidReports: IterationReport[] = [
    { iterationId: item.iterationId, attempt: 1, steps: steps.slice(0, 1) },
    {
      iterationId: item.iterationId,
      attempt: 1,
      steps: [steps[0], { ...steps[1], sessionId: "chat-2" }],
    },
    { iterationId: item.iterationId, attempt: 1, output: "x", correlationId: "c-9" },
  ];
  const refused: ReportIterationsResponse = await report(harness, work.runId, invalidReports);
  assertEquals(refused.rejected.map((rejected) => rejected.code), [
    "invalid_report",
    "invalid_report",
    "invalid_report",
  ]);
  assertEquals((await report(harness, work.runId, [sessionReport])).rejected, []);
  // A repeated report changes nothing, and a different one is refused.
  assertEquals((await report(harness, work.runId, [sessionReport])).rejected, []);
  const changed = await report(harness, work.runId, [{
    ...sessionReport,
    steps: [steps[0], { ...steps[1], output: "Another answer" }],
  }]);
  assertEquals(changed.rejected.map((rejected) => rejected.code), ["conflicting_report"]);
  await harness.drainJobsUntilIdle();
  const run = await readRun(harness, work.runId);
  assertEquals(run.verdict, "passed");
  assertEquals(readFirstIteration(run).attempts[0].transcript?.length, 2);
});

defineEvaluationTest("keeps the steps before a script's error", async (harness) => {
  await createDatasetWithTestCases(harness, [sessionTestCase()]);
  const work = await startRun(harness);
  const [item] = work.items;
  await report(harness, work.runId, [{
    iterationId: item.iterationId,
    attempt: 1,
    error: "Step 2 timed out",
    steps: [{ output: "It ships today.", correlationId: "c-1", sessionId: "chat-1" }],
  }]);
  const attempt = readFirstIteration(await readRun(harness, work.runId)).attempts[0];
  assertEquals([attempt.outcome, attempt.error, attempt.sessionId], [
    "error",
    "Step 2 timed out",
    "chat-1",
  ]);
  assertEquals(attempt.transcript?.map((step) => step.output), ["It ships today."]);
});

defineEvaluationTest("finds a Correlation ID reused in an earlier step", async (harness) => {
  await createDatasetWithTestCases(harness, [sessionTestCase({
    iterations: 2,
    evaluators: [{ type: "telemetry", name: "cancelled", match: { name: "execute_tool" } }],
  })]);
  const work = await startRun(harness);
  const [first, second] = work.items;
  await report(harness, work.runId, [
    {
      iterationId: first.iterationId,
      attempt: 1,
      steps: [
        { output: "a", correlationId: "shared", sessionId: "chat-1" },
        { output: "b", correlationId: "c-2", sessionId: "chat-1" },
      ],
    },
    {
      iterationId: second.iterationId,
      attempt: 1,
      steps: [
        { output: "a", correlationId: "c-3", sessionId: "chat-2" },
        { output: "b", correlationId: "shared", sessionId: "chat-2" },
      ],
    },
  ]);
  await harness.drainJobs();
  const run = await readRun(harness, work.runId);
  for (const iteration of run.testCases[0].iterations) {
    assertStringIncludes(iteration.attempts[0].error ?? "", "This Correlation ID is also used by");
  }
});
