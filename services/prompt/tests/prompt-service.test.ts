import { assert, assertEquals } from "@std/assert";
import type {
  ListPromptsResponse,
  ListPromptVersionsResponse,
  PromptLabel,
  PromptSummary,
  PromptVersion,
  PromptVersionComparison,
} from "@extispex/contracts";
import {
  createRequestAuthenticator,
  createStructuredLogger,
  IdentityUnavailableError,
  type ProjectResolver,
} from "@extispex/service-runtime";
import { createTestAccessTokens } from "@extispex/service-runtime/testing";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  createPromptService,
  openPromptDatabase,
  type PromptService,
} from "../src/create-service.ts";

const API_KEY = "test-api-key";
const OTHER_PROJECT_API_KEY = "other-project-api-key";

/** Stands in for Identity: two keys, each in its own Project. */
const testProjectResolver: ProjectResolver = {
  resolveProjectId: (apiKey) =>
    Promise.resolve(
      ({ [API_KEY]: "project-one", [OTHER_PROJECT_API_KEY]: "project-two" })[apiKey] ?? null,
    ),
};

/** Stands in for Identity's signing key, for access tokens with a Role. */
const testAccessTokens = await createTestAccessTokens();
const testRequestAuthenticator = createRequestAuthenticator({
  projectResolver: testProjectResolver,
  accessTokenVerifier: testAccessTokens.accessTokenVerifier,
});

const SUPPORT_AGENT_PROMPT = {
  name: "support-agent",
  description: "Answers customer questions",
  type: "chat",
  messages: [
    { role: "system", content: "You help customers of {{company}}.\nBe brief." },
    { role: "user", content: "{{ question }}" },
  ],
  modelParameters: {
    model: "gpt-4.1",
    temperature: 0.2,
    providerOptions: { response_format: { type: "json_object" } },
  },
  commitMessage: "First draft",
  labels: ["staging"],
};

type PromptTestBody = (promptService: PromptService) => Promise<void>;

function definePromptTest(testName: string, testBody: PromptTestBody): void {
  for (const testDatabase of listTestDatabases("prompt")) {
    Deno.test(
      `${testName} (${testDatabase.label})`,
      () => withPromptService(testDatabase.url, testBody),
    );
  }
}

async function withPromptService(databaseUrl: string, testBody: PromptTestBody): Promise<void> {
  const database = await openPromptDatabase(databaseUrl);
  try {
    await database.orm.em.fork().execute("delete from prompts");
    let clockMilliseconds = Date.parse("2026-11-07T10:00:00Z");
    await testBody(createPromptService({
      database,
      requestAuthenticator: testRequestAuthenticator,
      logger: createStructuredLogger("prompt-test"),
      // Each request is one second later, so that ordering by time is deterministic.
      readCurrentTime: () => new Date(clockMilliseconds += 1_000),
    }));
  } finally {
    await database.close();
  }
}

async function sendRequest(
  promptService: PromptService,
  method: string,
  path: string,
  options: { body?: unknown; apiKey?: string } = {},
): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${options.apiKey ?? API_KEY}` });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return await promptService.handleRequest(
    new Request(`http://prompt.test${path}`, {
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
  const responseBody = await response.json();
  assertEquals(response.status, expectedStatus, JSON.stringify(responseBody));
  return responseBody as ResponseBody;
}

function createSupportAgentPrompt(promptService: PromptService) {
  return expectJson<PromptVersion>(
    sendRequest(promptService, "POST", "/v1/prompts", { body: SUPPORT_AGENT_PROMPT }),
    201,
  );
}

function addVersion(promptService: PromptService, body: unknown) {
  return expectJson<PromptVersion>(
    sendRequest(promptService, "POST", "/v1/prompts/support-agent/versions", { body }),
    201,
  );
}

definePromptTest("creates a prompt with its first version", async (promptService) => {
  const firstVersion = await createSupportAgentPrompt(promptService);
  assertEquals(firstVersion, {
    type: "chat",
    promptName: "support-agent",
    versionNumber: 1,
    messages: SUPPORT_AGENT_PROMPT.messages,
    modelParameters: {
      model: "gpt-4.1",
      temperature: 0.2,
      maxOutputTokens: null,
      topP: null,
      providerOptions: { response_format: { type: "json_object" } },
    },
    variables: ["company", "question"],
    commitMessage: "First draft",
    labels: ["staging"],
    createdAt: "2026-11-07T10:00:01.000Z",
  } as PromptVersion);

  const prompt = await expectJson<PromptSummary>(
    sendRequest(promptService, "GET", "/v1/prompts/support-agent"),
    200,
  );
  assertEquals(prompt.description, "Answers customer questions");
  assertEquals(prompt.latestVersionNumber, 1);
  assertEquals(prompt.labels.map((label) => [label.name, label.versionNumber]), [["staging", 1]]);
});

definePromptTest("refuses a second prompt with the same name", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  const conflict = await expectJson<{ error: { code: string } }>(
    sendRequest(promptService, "POST", "/v1/prompts", { body: SUPPORT_AGENT_PROMPT }),
    409,
  );
  assertEquals(conflict.error.code, "conflict");
});

definePromptTest("numbers new versions and lists them newest first", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  const secondVersion = await addVersion(promptService, {
    type: "text",
    text: "Answer {{question}} for {{company}}.",
    commitMessage: "  Plain text instead of chat  ",
  });
  assertEquals(secondVersion.versionNumber, 2);
  assertEquals(secondVersion.type, "text");
  assertEquals(secondVersion.commitMessage, "Plain text instead of chat");
  assertEquals(secondVersion.modelParameters.model, null);

  const { versions } = await expectJson<ListPromptVersionsResponse>(
    sendRequest(promptService, "GET", "/v1/prompts/support-agent/versions"),
    200,
  );
  assertEquals(versions.map((version) => version.versionNumber), [2, 1]);
  assertEquals(versions[1].model, "gpt-4.1");
  assertEquals(versions[1].labels, ["staging"]);

  const firstVersion = await expectJson<PromptVersion>(
    sendRequest(promptService, "GET", "/v1/prompts/support-agent/versions/1"),
    200,
  );
  assertEquals(firstVersion.type, "chat");
});

definePromptTest("gives concurrent additions distinct numbers", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  const versions = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      addVersion(promptService, {
        type: "text",
        text: `Variant ${index}`,
      })),
  );
  assertEquals(versions.map((version) => version.versionNumber).sort(), [2, 3, 4, 5, 6]);
});

definePromptTest("moves a Prompt Label and reads a version by label", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  await addVersion(promptService, { type: "text", text: "Second" });

  const movedLabel = await expectJson<PromptLabel>(
    sendRequest(promptService, "PUT", "/v1/prompts/support-agent/labels/staging", {
      body: { versionNumber: 2 },
    }),
    200,
  );
  assertEquals(movedLabel.versionNumber, 2);
  await expectJson<PromptLabel>(
    sendRequest(promptService, "PUT", "/v1/prompts/support-agent/labels/production", {
      body: { versionNumber: 1 },
    }),
    200,
  );

  const stagingVersion = await expectJson<PromptVersion>(
    sendRequest(promptService, "GET", "/v1/prompts/support-agent/labels/staging"),
    200,
  );
  assertEquals([stagingVersion.versionNumber, stagingVersion.labels], [2, ["staging"]]);

  const productionVersion = await expectJson<PromptVersion>(
    sendRequest(promptService, "GET", "/v1/prompts/support-agent/labels/production"),
    200,
  );
  assertEquals(productionVersion.versionNumber, 1);

  const missingVersion = await sendRequest(
    promptService,
    "PUT",
    "/v1/prompts/support-agent/labels/production",
    { body: { versionNumber: 9 } },
  );
  assertEquals(missingVersion.status, 404);
  await missingVersion.body?.cancel();
});

definePromptTest("moves a label when a new version names it", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  const secondVersion = await addVersion(promptService, {
    type: "text",
    text: "Second",
    labels: ["staging", "staging", "candidate"],
  });
  assertEquals(secondVersion.labels, ["candidate", "staging"]);
  const firstVersion = await expectJson<PromptVersion>(
    sendRequest(promptService, "GET", "/v1/prompts/support-agent/versions/1"),
    200,
  );
  assertEquals(firstVersion.labels, []);
});

definePromptTest("removes a label but keeps its version", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  const removal = await sendRequest(
    promptService,
    "DELETE",
    "/v1/prompts/support-agent/labels/staging",
  );
  assertEquals(removal.status, 204);
  const readByLabel = await sendRequest(
    promptService,
    "GET",
    "/v1/prompts/support-agent/labels/staging",
  );
  assertEquals(readByLabel.status, 404);
  await readByLabel.body?.cancel();
  const secondRemoval = await sendRequest(
    promptService,
    "DELETE",
    "/v1/prompts/support-agent/labels/staging",
  );
  assertEquals(secondRemoval.status, 404);
  await secondRemoval.body?.cancel();
  await expectJson(sendRequest(promptService, "GET", "/v1/prompts/support-agent/versions/1"), 200);
});

definePromptTest("compares two versions by text and model parameters", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  await addVersion(promptService, {
    type: "chat",
    messages: [
      { role: "system", content: "You help customers of {{company}}.\nBe friendly." },
      { role: "user", content: "{{ question }}" },
    ],
    modelParameters: { model: "gpt-4.1", temperature: 0.7, maxOutputTokens: 800 },
  });

  const comparison = await expectJson<PromptVersionComparison>(
    sendRequest(
      promptService,
      "GET",
      "/v1/prompts/support-agent/compare?fromVersion=1&toVersion=2",
    ),
    200,
  );
  assert(comparison.hasChanges);
  assertEquals(comparison.contentChanges.map((contentChange) => contentChange.change), [
    "changed",
    "unchanged",
  ]);
  assertEquals(
    comparison.contentChanges[0].lines.map((line) => [line.change, line.text]),
    [
      ["unchanged", "You help customers of {{company}}."],
      ["removed", "Be brief."],
      ["added", "Be friendly."],
    ],
  );
  assertEquals(
    comparison.modelParameterChanges
      .filter((parameterChange) => parameterChange.change !== "unchanged")
      .map(({ parameter, change, fromValue, toValue }) => [parameter, change, fromValue, toValue]),
    [
      ["temperature", "changed", 0.2, 0.7],
      ["maxOutputTokens", "added", null, 800],
      ["providerOptions.response_format", "removed", { type: "json_object" }, null],
    ],
  );

  const missing = await sendRequest(
    promptService,
    "GET",
    "/v1/prompts/support-agent/compare?fromVersion=1&toVersion=7",
  );
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});

definePromptTest("lists prompts most recently changed first", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  await expectJson(
    sendRequest(promptService, "POST", "/v1/prompts", {
      body: { name: "run-summary", type: "text", text: "Summarize {{run}}." },
    }),
    201,
  );
  let { prompts } = await expectJson<ListPromptsResponse>(
    sendRequest(promptService, "GET", "/v1/prompts"),
    200,
  );
  assertEquals(prompts.map((prompt) => prompt.name), ["run-summary", "support-agent"]);

  await addVersion(promptService, { type: "text", text: "Newer" });
  ({ prompts } = await expectJson<ListPromptsResponse>(
    sendRequest(promptService, "GET", "/v1/prompts"),
    200,
  ));
  assertEquals(prompts.map((prompt) => [prompt.name, prompt.latestVersionNumber]), [
    ["support-agent", 2],
    ["run-summary", 1],
  ]);
});

definePromptTest("keeps each Project's prompts separate", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  const { prompts } = await expectJson<ListPromptsResponse>(
    sendRequest(promptService, "GET", "/v1/prompts", { apiKey: OTHER_PROJECT_API_KEY }),
    200,
  );
  assertEquals(prompts, []);
  const otherProjectRead = await sendRequest(
    promptService,
    "GET",
    "/v1/prompts/support-agent/versions/1",
    { apiKey: OTHER_PROJECT_API_KEY },
  );
  assertEquals(otherProjectRead.status, 404);
  await otherProjectRead.body?.cancel();
  // The same name is free in another Project.
  await expectJson(
    sendRequest(promptService, "POST", "/v1/prompts", {
      body: SUPPORT_AGENT_PROMPT,
      apiKey: OTHER_PROJECT_API_KEY,
    }),
    201,
  );
});

definePromptTest("rejects invalid prompts with a validation error", async (promptService) => {
  for (
    const invalidBody of [
      { ...SUPPORT_AGENT_PROMPT, name: "has spaces" },
      { ...SUPPORT_AGENT_PROMPT, messages: [] },
      { name: "plain", type: "text", text: "" },
      { name: "typo", type: "text", text: "Hi", modelParameters: { max_tokens: 10 } },
      { name: "hot", type: "text", text: "Hi", modelParameters: { temperature: 3 } },
      { name: "unknown-role", type: "chat", messages: [{ role: "tool", content: "x" }] },
    ]
  ) {
    const validationError = await expectJson<{ error: { code: string } }>(
      sendRequest(promptService, "POST", "/v1/prompts", { body: invalidBody }),
      400,
    );
    assertEquals(validationError.error.code, "invalid_request", JSON.stringify(invalidBody));
  }
});

definePromptTest("requires a valid API key", async (promptService) => {
  const response = await sendRequest(promptService, "GET", "/v1/prompts", {
    apiKey: "unknown-key",
  });
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error.code, "unauthenticated");
});

definePromptTest(
  "lets a viewer read and an editor change prompts with access tokens",
  async (promptService) => {
    await createSupportAgentPrompt(promptService);
    const viewerToken = await testAccessTokens.issueAccessToken({
      projectId: "project-one",
      role: "viewer",
    });
    const editorToken = await testAccessTokens.issueAccessToken({
      projectId: "project-one",
      role: "editor",
    });

    const { prompts } = await expectJson<ListPromptsResponse>(
      sendRequest(promptService, "GET", "/v1/prompts", { apiKey: viewerToken }),
      200,
    );
    assertEquals(prompts.map((prompt) => prompt.name), ["support-agent"]);
    for (
      const [method, path, body] of [
        ["POST", "/v1/prompts", { ...SUPPORT_AGENT_PROMPT, name: "viewer-prompt" }],
        ["POST", "/v1/prompts/support-agent/versions", { type: "text", text: "Hi" }],
        ["PUT", "/v1/prompts/support-agent/labels/production", { versionNumber: 1 }],
        ["DELETE", "/v1/prompts/support-agent/labels/staging", undefined],
      ] as const
    ) {
      const refusal = await expectJson<{ error: { code: string } }>(
        sendRequest(promptService, method, path, { apiKey: viewerToken, body }),
        403,
      );
      assertEquals(refusal.error.code, "forbidden", `${method} ${path}`);
    }

    await expectJson<PromptLabel>(
      sendRequest(promptService, "PUT", "/v1/prompts/support-agent/labels/production", {
        apiKey: editorToken,
        body: { versionNumber: 1 },
      }),
      200,
    );
  },
);

definePromptTest("keeps an access token to its own Project", async (promptService) => {
  await createSupportAgentPrompt(promptService);
  const otherProjectToken = await testAccessTokens.issueAccessToken({
    projectId: "project-two",
    role: "admin",
  });
  const { prompts } = await expectJson<ListPromptsResponse>(
    sendRequest(promptService, "GET", "/v1/prompts", { apiKey: otherProjectToken }),
    200,
  );
  assertEquals(prompts, []);
  // A token without a Project only manages access.
  await expectJson(
    sendRequest(promptService, "GET", "/v1/prompts", {
      apiKey: await testAccessTokens.issueAccessToken({}),
    }),
    401,
  );
});

Deno.test("asks clients to retry while API keys cannot be checked", async () => {
  const database = await openPromptDatabase("sqlite::memory:");
  try {
    const promptService = createPromptService({
      database,
      requestAuthenticator: createRequestAuthenticator({
        projectResolver: {
          resolveProjectId: () => Promise.reject(new IdentityUnavailableError("Identity is down.")),
        },
        accessTokenVerifier: testAccessTokens.accessTokenVerifier,
      }),
      logger: { ...createStructuredLogger("prompt-test"), warn: () => {} },
    });
    const response = await sendRequest(promptService, "GET", "/v1/prompts");
    assertEquals(response.status, 503);
    assertEquals(response.headers.get("retry-after"), "5");
    assertEquals((await response.json()).error.code, "identity_unavailable");
  } finally {
    await database.close();
  }
});

definePromptTest("publishes an OpenAPI 3.1 document", async (promptService) => {
  const response = await promptService.handleRequest(
    new Request("http://prompt.test/openapi.json"),
  );
  const openApiDocument = await response.json();
  assertEquals(openApiDocument.openapi, "3.1.0");
  assert(Object.keys(openApiDocument.paths).includes("/v1/prompts/{promptName}/compare"));
});
