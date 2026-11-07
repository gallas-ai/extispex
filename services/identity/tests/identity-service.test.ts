import { assert, assertEquals, assertMatch } from "@std/assert";
import type {
  ApiKey,
  CreatedApiKey,
  ListApiKeysResponse,
  ListProjectsResponse,
  Project,
} from "@extispex/contracts";
import { createStructuredLogger } from "@extispex/service-runtime";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  createFirstProjectIfNone,
  createIdentityService,
  type IdentityDatabase,
  type IdentityService,
  openIdentityDatabase,
} from "../src/create-service.ts";

const INSTANCE_ADMIN_KEY = "test-instance-admin-key-with-enough-characters";

interface IdentityTestContext {
  identityService: IdentityService;
  database: IdentityDatabase;
}

type IdentityTestBody = (testContext: IdentityTestContext) => Promise<void>;

function defineIdentityTest(testName: string, testBody: IdentityTestBody): void {
  for (const testDatabase of listTestDatabases("identity")) {
    Deno.test(
      `${testName} (${testDatabase.label})`,
      () => withIdentityService(testDatabase.url, testBody),
    );
  }
}

async function withIdentityService(databaseUrl: string, testBody: IdentityTestBody) {
  const database = await openIdentityDatabase(databaseUrl);
  try {
    await database.orm.em.fork().execute("delete from api_keys");
    await database.orm.em.fork().execute("delete from projects");
    let clockMilliseconds = Date.parse("2026-11-07T10:00:00Z");
    await testBody({
      database,
      identityService: createIdentityService({
        database,
        instanceAdminKey: INSTANCE_ADMIN_KEY,
        logger: createStructuredLogger("identity-test"),
        // Each request is one second later, so that ordering by time is deterministic.
        readCurrentTime: () => new Date(clockMilliseconds += 1_000),
      }),
    });
  } finally {
    await database.close();
  }
}

async function sendRequest(
  identityService: IdentityService,
  method: string,
  path: string,
  options: { body?: unknown; bearerToken?: string | null } = {},
): Promise<Response> {
  const headers = new Headers();
  const bearerToken = options.bearerToken === undefined ? INSTANCE_ADMIN_KEY : options.bearerToken;
  if (bearerToken !== null) headers.set("authorization", `Bearer ${bearerToken}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return await identityService.handleRequest(
    new Request(`http://identity.test${path}`, {
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

function createProject(identityService: IdentityService, name: string) {
  return expectJson<Project>(
    sendRequest(identityService, "POST", "/v1/projects", { body: { name } }),
    201,
  );
}

function createApiKey(identityService: IdentityService, projectId: string, name: string) {
  return expectJson<CreatedApiKey>(
    sendRequest(identityService, "POST", `/v1/projects/${projectId}/api-keys`, { body: { name } }),
    201,
  );
}

/** The Project that Identity resolves the key to, as Telemetry and Prompt ask for it. */
async function resolveApiKey(identityService: IdentityService, apiKey: string) {
  const response = await sendRequest(identityService, "POST", "/internal/v1/api-keys/resolve", {
    body: { apiKey },
    bearerToken: null,
  });
  const responseBody = await response.json();
  if (response.status === 404) return null;
  assertEquals(response.status, 200, JSON.stringify(responseBody));
  return responseBody.projectId as string;
}

defineIdentityTest("creates and lists Projects by name", async ({ identityService }) => {
  const checkoutProject = await createProject(identityService, "  checkout-bot ");
  await createProject(identityService, "assistant");

  assertEquals(checkoutProject.name, "checkout-bot");
  assertMatch(
    checkoutProject.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assertEquals(checkoutProject.createdAt, "2026-11-07T10:00:01.000Z");
  const { projects } = await expectJson<ListProjectsResponse>(
    sendRequest(identityService, "GET", "/v1/projects"),
    200,
  );
  assertEquals(projects.map((project) => project.name), ["assistant", "checkout-bot"]);
  assertEquals(
    await expectJson<Project>(
      sendRequest(identityService, "GET", `/v1/projects/${checkoutProject.id}`),
      200,
    ),
    checkoutProject,
  );
});

defineIdentityTest("refuses a second Project with the same name", async ({ identityService }) => {
  await createProject(identityService, "checkout-bot");
  const conflict = await expectJson<{ error: { code: string } }>(
    sendRequest(identityService, "POST", "/v1/projects", { body: { name: "checkout-bot" } }),
    409,
  );
  assertEquals(conflict.error.code, "conflict");
  for (const invalidName of ["", "   ", "x".repeat(65)]) {
    await expectJson(
      sendRequest(identityService, "POST", "/v1/projects", { body: { name: invalidName } }),
      400,
    );
  }
});

defineIdentityTest("requires the Instance admin key", async ({ identityService }) => {
  const project = await createProject(identityService, "checkout-bot");
  const { apiKey } = await createApiKey(identityService, project.id, "CI pipeline");
  for (const bearerToken of [null, "wrong-admin-key", apiKey]) {
    const rejection = await expectJson<{ error: { code: string } }>(
      sendRequest(identityService, "GET", "/v1/projects", { bearerToken }),
      401,
    );
    assertEquals(rejection.error.code, "unauthenticated");
  }
});

defineIdentityTest(
  "creates an API key that is shown once and resolves to its Project",
  async ({ identityService }) => {
    const project = await createProject(identityService, "checkout-bot");
    const createdKey = await createApiKey(identityService, project.id, "CI pipeline");

    assertMatch(createdKey.apiKey, /^extispex_[0-9A-Za-z]{43}$/);
    assertEquals(createdKey.keyPrefix, createdKey.apiKey.slice(0, 17));
    assertEquals(createdKey.name, "CI pipeline");
    assertEquals(createdKey.revokedAt, null);
    assertEquals(await resolveApiKey(identityService, createdKey.apiKey), project.id);

    const { apiKeys } = await expectJson<ListApiKeysResponse>(
      sendRequest(identityService, "GET", `/v1/projects/${project.id}/api-keys`),
      200,
    );
    const { apiKey: _secretValue, ...listedKey } = createdKey;
    assertEquals(apiKeys, [listedKey]);
    assert(!JSON.stringify(apiKeys).includes(createdKey.apiKey));
  },
);

defineIdentityTest("does not resolve unknown keys", async ({ identityService }) => {
  assertEquals(await resolveApiKey(identityService, "extispex_unknown"), null);
  await expectJson(
    sendRequest(identityService, "POST", "/internal/v1/api-keys/resolve", {
      body: { apiKey: "x".repeat(257) },
      bearerToken: null,
    }),
    400,
  );
});

defineIdentityTest("stops resolving a revoked key", async ({ identityService }) => {
  const project = await createProject(identityService, "checkout-bot");
  const revokedKey = await createApiKey(identityService, project.id, "Old laptop");
  const workingKey = await createApiKey(identityService, project.id, "CI pipeline");
  const revokePath = `/v1/projects/${project.id}/api-keys/${revokedKey.id}`;

  await expectJson(sendRequest(identityService, "DELETE", revokePath), 204);
  // Revoking again is not an error, so that a retried request succeeds.
  await expectJson(sendRequest(identityService, "DELETE", revokePath), 204);

  assertEquals(await resolveApiKey(identityService, revokedKey.apiKey), null);
  assertEquals(await resolveApiKey(identityService, workingKey.apiKey), project.id);
  const { apiKeys } = await expectJson<ListApiKeysResponse>(
    sendRequest(identityService, "GET", `/v1/projects/${project.id}/api-keys`),
    200,
  );
  assertEquals(
    apiKeys.map((apiKey: ApiKey) => [apiKey.name, apiKey.revokedAt]),
    [["CI pipeline", null], ["Old laptop", "2026-11-07T10:00:04.000Z"]],
  );
});

defineIdentityTest("revokes keys only within their Project", async ({ identityService }) => {
  const checkoutProject = await createProject(identityService, "checkout-bot");
  const assistantProject = await createProject(identityService, "assistant");
  const assistantKey = await createApiKey(identityService, assistantProject.id, "CI pipeline");

  await expectJson(
    sendRequest(
      identityService,
      "DELETE",
      `/v1/projects/${checkoutProject.id}/api-keys/${assistantKey.id}`,
    ),
    404,
  );
  assertEquals(await resolveApiKey(identityService, assistantKey.apiKey), assistantProject.id);
});

defineIdentityTest(
  "stops a deleted Project's keys and frees its name",
  async ({ identityService }) => {
    const project = await createProject(identityService, "checkout-bot");
    const { apiKey } = await createApiKey(identityService, project.id, "CI pipeline");

    await expectJson(sendRequest(identityService, "DELETE", `/v1/projects/${project.id}`), 204);

    assertEquals(await resolveApiKey(identityService, apiKey), null);
    await expectJson(sendRequest(identityService, "DELETE", `/v1/projects/${project.id}`), 404);
    await expectJson(sendRequest(identityService, "GET", `/v1/projects/${project.id}`), 404);
    await expectJson(
      sendRequest(identityService, "POST", `/v1/projects/${project.id}/api-keys`, {
        body: { name: "Too late" },
      }),
      404,
    );
    const { projects } = await expectJson<ListProjectsResponse>(
      sendRequest(identityService, "GET", "/v1/projects"),
      200,
    );
    assertEquals(projects, []);
    const recreatedProject = await createProject(identityService, "checkout-bot");
    assert(recreatedProject.id !== project.id);
  },
);

defineIdentityTest(
  "creates the first Project only on an empty Instance",
  async ({ identityService, database }) => {
    const bootstrapApiKey = "bootstrap-key-with-at-least-thirty-two-characters";
    const firstProject = await createFirstProjectIfNone(database, bootstrapApiKey);

    assert(firstProject !== null);
    assertEquals(firstProject.name, "Default");
    assertEquals(await resolveApiKey(identityService, bootstrapApiKey), firstProject.id);
    const { apiKeys } = await expectJson<ListApiKeysResponse>(
      sendRequest(identityService, "GET", `/v1/projects/${firstProject.id}/api-keys`),
      200,
    );
    assertEquals(apiKeys.map((apiKey) => apiKey.keyPrefix), ["bootstra"]);

    // Later starts change nothing, even after the first Project was deleted.
    assertEquals(
      await createFirstProjectIfNone(database, "another-key-of-thirty-two-chars!!"),
      null,
    );
    await expectJson(
      sendRequest(identityService, "DELETE", `/v1/projects/${firstProject.id}`),
      204,
    );
    assertEquals(
      await createFirstProjectIfNone(database, "another-key-of-thirty-two-chars!!"),
      null,
    );
  },
);

defineIdentityTest(
  "creates one first Project when several replicas start at once",
  async ({ database }) => {
    const creations = await Promise.all(
      Array.from(
        { length: 5 },
        (_, replicaIndex) =>
          createFirstProjectIfNone(database, `replica-${replicaIndex}-key-with-enough-characters`),
      ),
    );
    assertEquals(creations.filter((creation) => creation !== null).length, 1);
  },
);

defineIdentityTest("publishes an OpenAPI 3.1 document", async ({ identityService }) => {
  const response = await sendRequest(identityService, "GET", "/openapi.json", {
    bearerToken: null,
  });
  const openApiDocument = await response.json();
  assertEquals(openApiDocument.openapi, "3.1.0");
  const documentedPaths = Object.keys(openApiDocument.paths);
  assert(documentedPaths.includes("/v1/projects/{projectId}/api-keys/{apiKeyId}"));
  assert(documentedPaths.includes("/internal/v1/api-keys/resolve"));
});
