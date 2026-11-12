/** LLM providers, Grading Evaluators and LLM Summaries against fake providers, on both databases. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  EvaluationRun,
  EvaluationRunWork,
  LlmProvider,
  LlmSummarySettings,
  PromptVersion,
  Span,
} from "@extispex/contracts";
import { FAKE_SUMMARY_TEXT } from "./fixtures/fake-llm-provider.ts";
import {
  createDatasetWithTestCases,
  defineEvaluationTest,
  expectJson,
  outputReport,
  readRun,
  report,
  sendRequest,
  startRun,
  testAccessTokens,
  type TestHarness,
} from "./evaluation-test-harness.ts";

const OPENAI_API_KEY = "sk-test-openai-key";
const ANTHROPIC_API_KEY = "sk-ant-test-key";
const TYPESAFE_API_KEY = "ts-test-key";

function createProvider(harness: TestHarness, body: Record<string, unknown>) {
  return expectJson<LlmProvider>(
    sendRequest(harness, "POST", "/v1/llm-providers", { body }),
    201,
  );
}

function createOpenAiProvider(harness: TestHarness, name = "judge") {
  return createProvider(harness, {
    name,
    kind: "openai_compatible",
    baseUrl: `${harness.llmProvider.url}/v1`,
    apiKey: OPENAI_API_KEY,
    defaultModel: "gpt-test",
  });
}

function createTypeSafeProvider(harness: TestHarness) {
  return createProvider(harness, {
    name: "jev",
    kind: "typesafe",
    baseUrl: harness.llmProvider.url,
    apiKey: TYPESAFE_API_KEY,
    defaultModel: "jev-latest",
  });
}

/** A Prompt Version as the Prompt service returns it. */
function addPromptVersion(
  harness: TestHarness,
  name: string,
  versionNumber: number,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  model: string | null = null,
): PromptVersion {
  const promptVersion: PromptVersion = {
    type: "chat",
    messages,
    promptName: name,
    versionNumber,
    modelParameters: {
      model,
      temperature: null,
      maxOutputTokens: null,
      topP: null,
      providerOptions: {},
    },
    variables: [],
    commitMessage: null,
    labels: [],
    createdAt: "2026-11-10T10:00:00.000Z",
  };
  harness.promptVersions.set(`${name}@${versionNumber}`, promptVersion);
  return promptVersion;
}

const GRADER_MESSAGES = [
  { role: "system" as const, content: "Judge whether the support bot states the refund period." },
  { role: "user" as const, content: "Test Case {{testCaseName}}:\n{{transcript}}" },
];

function gradingTestCase(evaluator: Record<string, unknown>, overrides = {}) {
  return {
    name: "refund",
    input: { message: "What is your refund policy?" },
    evaluators: [{ type: "grading", name: "states-period", providerName: "judge", ...evaluator }],
    ...overrides,
  };
}

async function runOneOutput(harness: TestHarness, output: string) {
  const work = await startRun(harness);
  await report(harness, work.runId, [outputReport(work.items[0], output)]);
  await harness.drainJobsUntilIdle();
  return await readRun(harness, work.runId);
}

/** Reports the same Output for every attempt until the Iteration has a result. */
async function runUntilEnded(harness: TestHarness, output: string) {
  const work = await startRun(harness);
  let next: EvaluationRunWork = work;
  for (let attempt = 1; attempt <= 3 && next.items.length > 0; attempt++) {
    await report(harness, work.runId, [outputReport(next.items[0], output)]);
    await harness.drainJobsUntilIdle();
    next = await expectJson<EvaluationRunWork>(
      sendRequest(harness, "GET", `/v1/evaluation-runs/${work.runId}/work`),
      200,
    );
  }
  return await readRun(harness, work.runId);
}

defineEvaluationTest("keeps an LLM provider's API key out of every answer", async (harness) => {
  const created = await createOpenAiProvider(harness);
  assertEquals(created, {
    name: "judge",
    kind: "openai_compatible",
    capabilities: ["text_generation"],
    baseUrl: `${harness.llmProvider.url}/v1`,
    defaultModel: "gpt-test",
    description: "",
    hasApiKey: true,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  });
  const jev = await createTypeSafeProvider(harness);
  assertEquals(jev.capabilities, ["judgment"]);
  const local = await createProvider(harness, {
    name: "local",
    kind: "openai_compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "llama",
  });
  assertEquals(local.hasApiKey, false);
  const anthropic = await createProvider(harness, {
    name: "claude",
    kind: "anthropic",
    apiKey: ANTHROPIC_API_KEY,
    defaultModel: "claude-opus-5-5",
  });
  assertEquals(anthropic.baseUrl, "https://api.anthropic.com");

  const listed = await expectJson<{ llmProviders: LlmProvider[] }>(
    sendRequest(harness, "GET", "/v1/llm-providers"),
    200,
  );
  assertEquals(listed.llmProviders.map((provider) => provider.name), [
    "claude",
    "jev",
    "judge",
    "local",
  ]);
  assert(!JSON.stringify(listed).includes(OPENAI_API_KEY));
  const storedRows = await harness.database.orm.em.fork().execute<
    { sealed_api_key: string | null }[]
  >("select sealed_api_key from llm_providers");
  assert(storedRows.every((row) => !String(row.sealed_api_key).includes("test")));

  // Leaving the key out keeps it, null removes it, and Anthropic cannot do without one.
  const kept = await expectJson<LlmProvider>(
    sendRequest(harness, "PUT", "/v1/llm-providers/judge", {
      body: { baseUrl: `${harness.llmProvider.url}/v1`, defaultModel: "gpt-other" },
    }),
    200,
  );
  assertEquals([kept.defaultModel, kept.hasApiKey], ["gpt-other", true]);
  const cleared = await expectJson<LlmProvider>(
    sendRequest(harness, "PUT", "/v1/llm-providers/judge", {
      body: { baseUrl: `${harness.llmProvider.url}/v1`, defaultModel: "gpt-test", apiKey: null },
    }),
    200,
  );
  assertEquals(cleared.hasApiKey, false);
  await expectJson(
    sendRequest(harness, "PUT", "/v1/llm-providers/claude", {
      body: { baseUrl: "https://api.anthropic.com", defaultModel: "x", apiKey: null },
    }),
    400,
  );
  await expectJson(
    sendRequest(harness, "POST", "/v1/llm-providers", {
      body: { name: "no-key", kind: "typesafe", defaultModel: "jev-latest" },
    }),
    400,
  );
  await expectJson(
    sendRequest(harness, "POST", "/v1/llm-providers", {
      body: { name: "judge", kind: "anthropic", apiKey: "x", defaultModel: "x" },
    }),
    409,
  );
  const viewerToken = await testAccessTokens.issueAccessToken({
    projectId: "project-one",
    role: "viewer",
  });
  await expectJson(
    sendRequest(harness, "GET", "/v1/llm-providers/judge", { bearerToken: viewerToken }),
    200,
  );
  await expectJson(
    sendRequest(harness, "DELETE", "/v1/llm-providers/judge", { bearerToken: viewerToken }),
    403,
  );
  await expectJson(sendRequest(harness, "DELETE", "/v1/llm-providers/judge"), 204);
  await expectJson(sendRequest(harness, "GET", "/v1/llm-providers/judge"), 404);
});

defineEvaluationTest("refuses Grading Evaluators that are not well formed", async (harness) => {
  await expectJson(
    sendRequest(harness, "POST", "/v1/datasets", { body: { name: "support-bot" } }),
    201,
  );
  const invalidEvaluators = [
    {},
    { prompt: { name: "grader", version: 1 }, question: { type: "noul", instructions: "Ok?" } },
    {
      question: {
        type: "choice",
        instructions: "Which?",
        criteria: { a: "", b: "" },
        passingChoices: ["c"],
      },
    },
    {
      question: {
        type: "choice",
        instructions: "Which?",
        criteria: { a: "", b: "" },
        passingChoices: ["a", "b"],
      },
    },
    {
      question: {
        type: "score",
        instructions: "How good?",
        criteria: ["bad", "good"],
        passScore: 2,
      },
    },
    { question: { type: "noul", instructions: "Ok?", passProbability: 1 } },
  ];
  for (const evaluator of invalidEvaluators) {
    await expectJson(
      sendRequest(harness, "POST", "/v1/datasets/support-bot/test-cases", {
        body: gradingTestCase(evaluator),
      }),
      400,
    );
  }
});

defineEvaluationTest(
  "judges an Output with a Prompt Version and a structured verdict",
  async (harness) => {
    await createOpenAiProvider(harness);
    addPromptVersion(harness, "grader", 2, GRADER_MESSAGES);
    await createDatasetWithTestCases(harness, [
      gradingTestCase({ prompt: { name: "grader", version: 2 } }),
    ]);

    const passedRun = await runOneOutput(harness, "Refunds within 30 days.");
    assertEquals(passedRun.verdict, "passed");
    const [result] = passedRun.testCases[0].iterations[0].attempts[0].evaluatorResults;
    assertEquals(result, {
      name: "states-period",
      type: "grading",
      outcome: "passed",
      reason: "The application states the 30-day refund policy.",
      score: 0.9,
      model: "gpt-test-2026-01-01",
      prompt: {
        name: "grader",
        version: 2,
        type: "chat",
        text: null,
        messages: GRADER_MESSAGES,
      },
    });
    const [request] = harness.llmProvider.requests;
    assertEquals(request.path, "/v1/chat/completions");
    assertEquals(request.headers.get("authorization"), `Bearer ${OPENAI_API_KEY}`);
    assertEquals(request.body.model, "gpt-test");
    assertEquals(request.body.response_format.type, "json_schema");
    assertEquals(request.body.response_format.json_schema.strict, true);
    assertEquals(request.body.messages.length, 2);
    assertStringIncludes(request.body.messages[0].content, "refund period");
    assertStringIncludes(request.body.messages[0].content, '"passed": boolean');
    assertEquals(
      request.body.messages[1].content,
      'Test Case refund:\nUser (step 1): {"message":"What is your refund policy?"}\n' +
        "Application: Refunds within 30 days.",
    );

    const failedRun = await runOneOutput(harness, "Please ask a human.");
    assertEquals(failedRun.verdict, "failed");
    const [failedResult] = failedRun.testCases[0].iterations[0].attempts[0].evaluatorResults;
    assertEquals([failedResult.outcome, failedResult.score], ["failed", 0.2]);
  },
);

defineEvaluationTest("judges a Session's whole Transcript", async (harness) => {
  await createOpenAiProvider(harness);
  addPromptVersion(harness, "grader", 1, GRADER_MESSAGES, "gpt-from-prompt");
  await createDatasetWithTestCases(harness, [{
    name: "cancel-order",
    scope: "session",
    steps: [{ input: { message: "Where is my order?" } }, { input: "Can I cancel it?" }],
    evaluators: [{
      type: "grading",
      name: "states-period",
      providerName: "judge",
      prompt: { name: "grader", version: 1 },
    }],
  }]);
  const work = await startRun(harness);
  await report(harness, work.runId, [{
    iterationId: work.items[0].iterationId,
    attempt: 1,
    steps: [
      { output: "It ships today.", correlationId: "c-1", sessionId: "chat-1" },
      { output: "Yes, within 30 days.", correlationId: "c-2", sessionId: "chat-1" },
    ],
  }]);
  await harness.drainJobsUntilIdle();
  assertEquals((await readRun(harness, work.runId)).verdict, "passed");
  const [request] = harness.llmProvider.requests;
  assertEquals(request.body.model, "gpt-from-prompt");
  assertEquals(
    request.body.messages[1].content,
    'Test Case cancel-order:\nUser (step 1): {"message":"Where is my order?"}\n' +
      "Application: It ships today.\n\nUser (step 2): Can I cancel it?\n" +
      "Application: Yes, within 30 days.",
  );
});

defineEvaluationTest(
  "ends as Error, not as a failure, when the verdict is unusable",
  async (harness) => {
    await createOpenAiProvider(harness);
    addPromptVersion(harness, "grader", 1, GRADER_MESSAGES);
    await createDatasetWithTestCases(harness, [
      gradingTestCase({ prompt: { name: "grader", version: 1 } }),
    ]);
    harness.llmProvider.answer = () =>
      Response.json({
        model: "gpt-test",
        choices: [{ message: { content: '{"passed": "yes"}' }, finish_reason: "stop" }],
      });
    const run = await runUntilEnded(harness, "Refunds within 30 days.");
    assertEquals(run.verdict, "error");
    const { attempts } = run.testCases[0].iterations[0];
    assertEquals(attempts.length, 3);
    assertEquals(
      attempts[0].evaluatorResults[0].reason,
      "The LLM's verdict is not the JSON object it was asked for.",
    );
  },
);

defineEvaluationTest("tries a busy provider again before the attempt fails", async (harness) => {
  await createOpenAiProvider(harness);
  addPromptVersion(harness, "grader", 1, GRADER_MESSAGES);
  await createDatasetWithTestCases(harness, [
    gradingTestCase({ prompt: { name: "grader", version: 1 } }),
  ]);
  let callCount = 0;
  harness.llmProvider.answer = () =>
    ++callCount === 1
      ? Response.json({ error: { message: "Rate limit reached" } }, {
        status: 429,
        headers: { "retry-after": "0" },
      })
      : null;
  const run = await runOneOutput(harness, "Refunds within 30 days.");
  assertEquals(run.verdict, "passed");
  assertEquals(run.testCases[0].iterations[0].attempts.length, 1);
  assertEquals(harness.llmProvider.requests.length, 2);

  // A refused key is not retried, and the provider's own message says why.
  harness.llmProvider.answer = () =>
    Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 });
  const refusedRun = await runUntilEnded(harness, "Refunds within 30 days.");
  assertEquals(
    refusedRun.testCases[0].iterations[0].attempts[0].evaluatorResults[0].reason,
    "The LLM provider answered with status 401: Incorrect API key provided",
  );
});

defineEvaluationTest("explains a missing provider, prompt or Prompt Variable", async (harness) => {
  await createTypeSafeProvider(harness);
  addPromptVersion(harness, "grader", 1, [{ role: "user", content: "{{transcript}} {{spans}}" }]);
  await createDatasetWithTestCases(harness, [{
    name: "refund",
    input: "Refund?",
    evaluators: [
      {
        type: "grading",
        name: "no-provider",
        providerName: "judge",
        prompt: { name: "grader", version: 1 },
      },
      {
        type: "grading",
        name: "wrong-capability",
        providerName: "jev",
        prompt: { name: "grader", version: 1 },
      },
    ],
  }]);
  let run = await runUntilEnded(harness, "Within 30 days.");
  let reasons = run.testCases[0].iterations[0].attempts[0].evaluatorResults.map((result) =>
    result.reason
  );
  assertEquals(reasons, [
    "The LLM provider judge does not exist.",
    "The LLM provider jev cannot follow a prompt.",
  ]);

  await createOpenAiProvider(harness);
  await expectJson(
    sendRequest(harness, "PUT", "/v1/datasets/support-bot/test-cases/refund", {
      body: {
        input: "Refund?",
        evaluators: [
          {
            type: "grading",
            name: "missing-version",
            providerName: "judge",
            prompt: { name: "grader", version: 9 },
          },
          {
            type: "grading",
            name: "spans-off",
            providerName: "judge",
            prompt: { name: "grader", version: 1 },
          },
        ],
      },
    }),
    200,
  );
  run = await runUntilEnded(harness, "Within 30 days.");
  reasons = run.testCases[0].iterations[0].attempts[0].evaluatorResults.map((result) =>
    result.reason
  );
  assertEquals(reasons, [
    "Prompt grader has no version 9.",
    "The prompt uses {{spans}}, which a Grading Evaluator does not fill. Turn on includeSpans " +
    "for {{spans}}.",
  ]);
  assertEquals(harness.llmProvider.requests.length, 0);
});

defineEvaluationTest("asks TypeSafe Jev typed questions about the Transcript", async (harness) => {
  await createTypeSafeProvider(harness);
  const jevEvaluator = (name: string, question: Record<string, unknown>) => ({
    type: "grading",
    name,
    providerName: "jev",
    question,
  });
  await createDatasetWithTestCases(harness, [{
    name: "refund",
    input: { message: "What is your refund policy?" },
    expectedOutput: "Refunds within 30 days.",
    evaluators: [
      jevEvaluator("states-period", {
        type: "noul",
        instructions: "Does the application state how long refunds are possible?",
        criteria: { true: "A number of days is given", false: "No period is given" },
        passProbability: 0.7,
      }),
      jevEvaluator("helpfulness", {
        type: "score",
        instructions: "How helpful is the answer?",
        criteria: ["Unhelpful", "Partly helpful", "Fully helpful"],
        passScore: 1.5,
      }),
      jevEvaluator("tone", {
        type: "choice",
        instructions: "What is the tone of the answer?",
        criteria: { polite: "Friendly and polite", neutral: "Plain", rude: "Hostile" },
        passingChoices: ["polite", "neutral"],
      }),
    ],
  }]);
  const run = await runOneOutput(harness, "Refunds within 30 days.");
  assertEquals(run.verdict, "passed");
  const results = run.testCases[0].iterations[0].attempts[0].evaluatorResults;
  assertEquals(results.map((result) => [result.name, result.outcome, result.score]), [
    ["states-period", "passed", 0.93],
    ["helpfulness", "passed", 1],
    ["tone", "passed", 0.9],
  ]);
  assertEquals(
    results[0].reason,
    "The probability of yes is 0.93; 0.70 or more passes.",
  );
  assertEquals(
    results[1].reason,
    'The expected level is 2.00 of 2, nearest to "Fully helpful"; 1.5 or more passes.',
  );
  assertEquals(results[2].model, "jev-1.14.0");
  const [noulRequest] = harness.llmProvider.requests;
  assertEquals(noulRequest.path, "/v1/systemone");
  assertEquals(noulRequest.headers.get("authorization"), `Bearer ${TYPESAFE_API_KEY}`);
  assertEquals(noulRequest.body, {
    model: "jev-latest",
    state: {
      testCase: "refund",
      expectedOutput: "Refunds within 30 days.",
      transcript: [{
        step: 1,
        input: { message: "What is your refund policy?" },
        output: "Refunds within 30 days.",
      }],
    },
    questions: {
      verdict: {
        type: "noul",
        instructions: "Does the application state how long refunds are possible?",
        criteria: { true: "A number of days is given", false: "No period is given" },
      },
    },
  });

  const failedRun = await runOneOutput(harness, "Go away.");
  assertEquals(
    failedRun.testCases[0].iterations[0].attempts[0].evaluatorResults.map((result) =>
      result.outcome
    ),
    ["failed", "failed", "failed"],
  );
});

defineEvaluationTest("talks to Anthropic's Messages API", async (harness) => {
  await createProvider(harness, {
    name: "judge",
    kind: "anthropic",
    baseUrl: harness.llmProvider.url,
    apiKey: ANTHROPIC_API_KEY,
    defaultModel: "claude-opus-5-5",
  });
  addPromptVersion(harness, "grader", 1, GRADER_MESSAGES);
  await createDatasetWithTestCases(harness, [
    gradingTestCase({ prompt: { name: "grader", version: 1 } }),
  ]);
  const run = await runOneOutput(harness, "Refunds within 30 days.");
  assertEquals(run.verdict, "passed");
  const [request] = harness.llmProvider.requests;
  assertEquals(request.path, "/v1/messages");
  assertEquals(request.headers.get("x-api-key"), ANTHROPIC_API_KEY);
  assertEquals(request.headers.get("anthropic-version"), "2023-06-01");
  assertEquals(request.body.model, "claude-opus-5-5");
  assertEquals(request.body.max_tokens, 4_096);
  assertStringIncludes(request.body.system, "refund period");
  assertEquals(request.body.messages.map((message: { role: string }) => message.role), ["user"]);
  assertEquals(request.body.output_config.format.type, "json_schema");
  assert(!("temperature" in request.body));

  harness.llmProvider.answer = () =>
    Response.json({ model: "claude-opus-5-5", stop_reason: "refusal", content: [] });
  const refusedRun = await runUntilEnded(harness, "Refunds within 30 days.");
  assertEquals(refusedRun.verdict, "error");
  assertEquals(
    refusedRun.testCases[0].iterations[0].attempts[0].evaluatorResults[0].reason,
    "The model declined to answer.",
  );
});

defineEvaluationTest("adds the spans only when the Evaluator asks for them", async (harness) => {
  await createOpenAiProvider(harness);
  addPromptVersion(harness, "grader", 1, [{ role: "user", content: "{{output}}\n{{spans}}" }]);
  await createDatasetWithTestCases(harness, [
    gradingTestCase({ prompt: { name: "grader", version: 1 }, includeSpans: true }),
  ]);
  const work = await startRun(harness);
  const item = work.items[0];
  await report(harness, work.runId, [outputReport(item, "Refunds within 30 days.")]);
  // The Grading Evaluator waits for the trace like a Telemetry Evaluator does.
  await harness.drainJobs();
  assertEquals(harness.llmProvider.requests.length, 0);
  const correlationId = `correlation-${item.iterationId}-1`;
  const storedAt = harness.readClock().toISOString();
  harness.telemetry.correlations.set(correlationId, {
    firstReceivedAt: storedAt,
    traces: [{ traceId: "trace-1", rootSpanStoredAt: storedAt }],
  });
  const span: Span = {
    traceId: "trace-1",
    spanId: "span-1",
    parentSpanId: null,
    name: "execute_tool",
    kind: "internal",
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    durationMilliseconds: 12,
    statusCode: "ok",
    statusMessage: null,
    serviceName: "support-bot",
    correlationId,
    sessionId: null,
    attributes: { "gen_ai.tool.name": "lookup_refund" },
    resourceAttributes: {},
    receivedAt: storedAt,
    arrivedAfterEvaluation: false,
  };
  harness.telemetry.spans.set(correlationId, [span]);
  harness.advanceClock(11_000);
  await harness.drainJobsUntilIdle();
  assertEquals((await readRun(harness, work.runId)).verdict, "passed");
  const [request] = harness.llmProvider.requests;
  assertStringIncludes(request.body.messages[1].content, '"gen_ai.tool.name":"lookup_refund"');
  assert(!request.body.messages[1].content.includes("resourceAttributes"));
});

defineEvaluationTest("writes the LLM Summary of every finished run", async (harness) => {
  await createOpenAiProvider(harness);
  await createTypeSafeProvider(harness);
  await createDatasetWithTestCases(harness, [{
    name: "refund",
    input: "Refund?",
    evaluators: [{ type: "regex", name: "mentions-days", pattern: "30 days" }],
  }]);

  // Without settings, a run gets no LLM Summary.
  let run = await runOneOutput(harness, "Within 30 days.");
  const unconfigured = await expectJson<EvaluationRun>(
    sendRequest(harness, "GET", `/v1/evaluation-runs/${run.id}`),
    200,
  );
  assertEquals(unconfigured.llmSummary?.status, "not_configured");

  await expectJson(
    sendRequest(harness, "PUT", "/v1/llm-summary-settings", { body: { providerName: "jev" } }),
    400,
  );
  await expectJson(
    sendRequest(harness, "PUT", "/v1/llm-summary-settings", { body: { providerName: "nobody" } }),
    400,
  );
  const settings = await expectJson<LlmSummarySettings>(
    sendRequest(harness, "PUT", "/v1/llm-summary-settings", { body: { providerName: "judge" } }),
    200,
  );
  assertEquals([settings.providerName, settings.prompt], ["judge", null]);

  const work = await startRun(harness);
  await report(harness, work.runId, [outputReport(work.items[0], "Ask a human.")]);
  await harness.drainJobs();
  const finished = await expectJson<EvaluationRun>(
    sendRequest(harness, "GET", `/v1/evaluation-runs/${work.runId}`),
    200,
  );
  assertEquals([finished.status, finished.llmSummary?.status], ["finished", "pending"]);
  assertEquals(harness.queuedJobs, [{ kind: "summarize", runId: work.runId }]);
  await harness.drainJobsUntilIdle();
  run = await readRun(harness, work.runId);
  assertEquals(run.llmSummary, {
    status: "completed",
    text: FAKE_SUMMARY_TEXT,
    error: null,
    providerName: "judge",
    model: "gpt-test-2026-01-01",
    prompt: null,
    generatedAt: run.llmSummary?.generatedAt ?? null,
  });
  const summaryRequest = harness.llmProvider.requests.at(-1)!;
  assert(!("response_format" in summaryRequest.body));
  assertEquals(summaryRequest.body.max_completion_tokens, 1_024);
  const resultsText = summaryRequest.body.messages[1].content;
  assertStringIncludes(resultsText, "Verdict: failed");
  assertStringIncludes(resultsText, "- refund (trace): failed, 0 of 1 Iterations passed");
  assertStringIncludes(resultsText, "mentions-days (failed): The Output does not match /30 days/.");

  // A repeated job changes nothing.
  await harness.worker.handleJob({ kind: "summarize", runId: work.runId });
  assertEquals(harness.llmProvider.requests.length, 1);
});

defineEvaluationTest("writes the LLM Summary with the user's own prompt", async (harness) => {
  await createOpenAiProvider(harness);
  addPromptVersion(harness, "summary", 3, [
    { role: "user", content: "Summarize {{datasetName}} ({{verdict}}):\n{{results}}" },
  ]);
  await expectJson(
    sendRequest(harness, "PUT", "/v1/llm-summary-settings", {
      body: { providerName: "judge", prompt: { name: "summary", version: 3 } },
    }),
    200,
  );
  await createDatasetWithTestCases(harness, [{
    name: "refund",
    input: "Refund?",
    evaluators: [{ type: "regex", name: "mentions-days", pattern: "30 days" }],
  }]);
  const run = await runOneOutput(harness, "Within 30 days.");
  assertEquals(run.llmSummary?.prompt, { name: "summary", version: 3 });
  assertEquals(run.llmSummary?.status, "completed");
  const [request] = harness.llmProvider.requests;
  assertEquals(request.body.messages.length, 1);
  assertStringIncludes(
    request.body.messages[0].content,
    "Summarize support-bot (passed):\nDataset:",
  );
});

defineEvaluationTest("retries an LLM Summary and then records why it failed", async (harness) => {
  await createOpenAiProvider(harness);
  await expectJson(
    sendRequest(harness, "PUT", "/v1/llm-summary-settings", { body: { providerName: "judge" } }),
    200,
  );
  await createDatasetWithTestCases(harness, [{
    name: "refund",
    input: "Refund?",
    evaluators: [{ type: "regex", name: "mentions-days", pattern: "30 days" }],
  }]);
  harness.llmProvider.answer = () =>
    Response.json({ error: { message: "The server had an error" } }, { status: 500 });
  const run = await runOneOutput(harness, "Within 30 days.");
  assertEquals(run.verdict, "passed", "An LLM Summary never changes a verdict.");
  assertEquals(run.llmSummary?.status, "failed");
  assertEquals(
    run.llmSummary?.error,
    "The LLM provider answered with status 500: The server had an error",
  );
  // Three attempts, each with the client's own two retries.
  assertEquals(harness.llmProvider.requests.length, 9);
});

defineEvaluationTest("queues a lost LLM Summary job again", async (harness) => {
  await createOpenAiProvider(harness);
  await expectJson(
    sendRequest(harness, "PUT", "/v1/llm-summary-settings", { body: { providerName: "judge" } }),
    200,
  );
  await createDatasetWithTestCases(harness, [{
    name: "refund",
    input: "Refund?",
    evaluators: [{ type: "regex", name: "mentions-days", pattern: "30 days" }],
  }]);
  const work = await startRun(harness);
  await report(harness, work.runId, [outputReport(work.items[0], "Within 30 days.")]);
  await harness.drainJobs();
  assertEquals(harness.queuedJobs.splice(0), [{ kind: "summarize", runId: work.runId }]);
  await harness.worker.runMaintenance();
  assertEquals(harness.queuedJobs, [], "A fresh job is not stalled yet.");
  harness.advanceClock(121_000);
  await harness.worker.runMaintenance();
  assertEquals(harness.queuedJobs, [{ kind: "summarize", runId: work.runId }]);
  await harness.drainJobsUntilIdle();
  assertEquals((await readRun(harness, work.runId)).llmSummary?.status, "completed");
});

defineEvaluationTest("stops LLM Summaries with a deleted provider", async (harness) => {
  await createOpenAiProvider(harness);
  await expectJson(
    sendRequest(harness, "PUT", "/v1/llm-summary-settings", { body: { providerName: "judge" } }),
    200,
  );
  await expectJson(sendRequest(harness, "DELETE", "/v1/llm-providers/judge"), 204);
  const settings = await expectJson<LlmSummarySettings>(
    sendRequest(harness, "GET", "/v1/llm-summary-settings"),
    200,
  );
  assertEquals(settings.providerName, null);
});
