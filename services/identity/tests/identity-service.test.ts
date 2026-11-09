import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type {
  AccessibleProject,
  AccessTokenResponse,
  ApiKey,
  CreatedApiKey,
  Group,
  ListApiKeysResponse,
  ListProjectsResponse,
  ListRoleAssignmentsResponse,
  ListUsersResponse,
  Project,
  User,
} from "@extispex/contracts";
import { createAccessTokenVerifier, createStructuredLogger } from "@extispex/service-runtime";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  createFirstAdministratorIfNone,
  createFirstProjectIfNone,
  createIdentityService,
  type IdentityDatabase,
  type IdentityService,
  openIdentityDatabase,
} from "../src/create-service.ts";
import {
  MAXIMUM_ATTEMPTS_PER_ACCOUNT,
  MAXIMUM_ATTEMPTS_PER_ADDRESS,
  THROTTLE_WINDOW_SECONDS,
} from "../src/sign-in/password-attempt-throttle.ts";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const USER_PASSWORD = "a-user-password";
const EVALUATION_CLIENT_SECRET = "evaluation-client-secret-with-enough-characters";
/** Fast hashes keep the tests quick; production uses 600,000 iterations. */
const PASSWORD_HASH_ITERATIONS = 1_000;

interface IdentityTestContext {
  identityService: IdentityService;
  database: IdentityDatabase;
  /** The first administrator's sign-in, created for every test. */
  admin: SignedInBrowser;
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

const IDENTITY_TABLES = [
  "company_group_mappings",
  "oidc_sign_in_attempts",
  "sign_in_throttles",
  "sign_ins",
  "group_members",
  "role_assignments",
  "groups",
  "users",
  "api_keys",
  "projects",
  "signing_keys",
];

function createTestIdentityService(
  database: IdentityDatabase,
  options: { areLocalAccountsEnabled?: boolean } = {},
): IdentityService {
  let clockMilliseconds = Date.parse("2026-11-07T10:00:00Z");
  return createIdentityService({
    database,
    areLocalAccountsEnabled: options.areLocalAccountsEnabled ?? true,
    serviceClientSecrets: new Map([["evaluation", EVALUATION_CLIENT_SECRET]]),
    logger: createStructuredLogger("identity-test"),
    passwordHashIterations: PASSWORD_HASH_ITERATIONS,
    // Each reading of the clock is one second later, so that ordering by time is deterministic.
    readCurrentTime: () => new Date(clockMilliseconds += 1_000),
  });
}

async function withIdentityService(databaseUrl: string, testBody: IdentityTestBody) {
  const database = await openIdentityDatabase(databaseUrl);
  try {
    for (const tableName of IDENTITY_TABLES) {
      await database.orm.em.fork().execute(`delete from ${tableName}`);
    }
    await createFirstAdministratorIfNone(
      database,
      { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      { passwordHashIterations: PASSWORD_HASH_ITERATIONS },
    );
    const identityService = createTestIdentityService(database);
    await testBody({
      database,
      identityService,
      admin: await signIn(identityService, ADMIN_EMAIL, ADMIN_PASSWORD),
    });
  } finally {
    await database.close();
  }
}

interface RequestOptions {
  body?: unknown;
  bearerToken?: string;
  cookie?: string;
  basicCredentials?: string;
  headers?: Record<string, string>;
}

async function sendRequest(
  identityService: IdentityService,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.bearerToken !== undefined) {
    headers.set("authorization", `Bearer ${options.bearerToken}`);
  }
  if (options.basicCredentials !== undefined) {
    headers.set("authorization", `Basic ${btoa(options.basicCredentials)}`);
  }
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
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

async function expectErrorCode(responsePromise: Promise<Response>, expectedStatus: number) {
  return (await expectJson<{ error: { code: string } }>(responsePromise, expectedStatus)).error
    .code;
}

/** A browser that signed in: its cookie, and access tokens it gets with it. */
interface SignedInBrowser {
  cookie: string;
  /** An access token without a Project, which manages access. */
  accessToken: string;
  requestAccessToken(projectId?: string): Promise<Response>;
  /** Sends a request with the access token without a Project. */
  send(method: string, path: string, body?: unknown): Promise<Response>;
}

async function signIn(
  identityService: IdentityService,
  email: string,
  password: string,
): Promise<SignedInBrowser> {
  const response = await sendRequest(identityService, "POST", "/v1/sign-in", {
    body: { email, password },
  });
  await expectJson<User>(Promise.resolve(response), 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const requestAccessToken = (projectId?: string) =>
    sendRequest(identityService, "POST", "/v1/sign-in/access-tokens", {
      cookie,
      body: projectId === undefined ? {} : { projectId },
    });
  const { accessToken } = await expectJson<AccessTokenResponse>(requestAccessToken(), 200);
  return {
    cookie,
    accessToken,
    requestAccessToken,
    send: (method, path, body) =>
      sendRequest(identityService, method, path, { bearerToken: accessToken, body }),
  };
}

function createProject(admin: SignedInBrowser, name: string) {
  return expectJson<Project>(admin.send("POST", "/v1/projects", { name }), 201);
}

function createApiKey(admin: SignedInBrowser, projectId: string, name: string) {
  return expectJson<CreatedApiKey>(
    admin.send("POST", `/v1/projects/${projectId}/api-keys`, { name }),
    201,
  );
}

function createUser(admin: SignedInBrowser, email: string, isInstanceAdmin = false) {
  return expectJson<User>(
    admin.send("POST", "/v1/users", {
      email,
      displayName: email.split("@")[0],
      password: USER_PASSWORD,
      isInstanceAdmin,
    }),
    201,
  );
}

/** Creates a Group with the user in it and gives the Group the Role in the Project. */
async function grantRole(
  admin: SignedInBrowser,
  user: User,
  projectId: string,
  role: string,
  groupName = `${user.email} ${role}`,
): Promise<Group> {
  const group = await expectJson<Group>(admin.send("POST", "/v1/groups", { name: groupName }), 201);
  await expectJson(admin.send("PUT", `/v1/groups/${group.id}/members/${user.id}`), 200);
  await expectJson(
    admin.send("PUT", `/v1/projects/${projectId}/role-assignments/${group.id}`, { role }),
    200,
  );
  return group;
}

async function requestServiceToken(
  identityService: IdentityService,
  body: unknown,
  basicCredentials = `evaluation:${EVALUATION_CLIENT_SECRET}`,
) {
  return await sendRequest(identityService, "POST", "/internal/v1/service-tokens", {
    basicCredentials,
    body,
  });
}

/** The Project that Identity resolves the key to, as Telemetry and Prompt ask for it. */
async function resolveApiKey(identityService: IdentityService, apiKey: string) {
  const { accessToken } = await expectJson<AccessTokenResponse>(
    requestServiceToken(identityService, {}),
    200,
  );
  const response = await sendRequest(identityService, "POST", "/internal/v1/api-keys/resolve", {
    body: { apiKey },
    bearerToken: accessToken,
  });
  const responseBody = await response.json();
  if (response.status === 404) return null;
  assertEquals(response.status, 200, JSON.stringify(responseBody));
  return responseBody.projectId as string;
}

defineIdentityTest(
  "signs in with a local account and keeps the cookie from scripts",
  async ({ identityService }) => {
    const response = await sendRequest(identityService, "POST", "/v1/sign-in", {
      body: { email: "  Admin@Example.com ", password: ADMIN_PASSWORD },
    });
    const user = await expectJson<User>(Promise.resolve(response), 200);
    assertEquals(user.email, ADMIN_EMAIL);
    assertEquals(user.isInstanceAdmin, true);
    assert(!JSON.stringify(user).includes("pbkdf2"));
    const setCookie = response.headers.get("set-cookie")!;
    assertMatch(setCookie, /^extispex_sign_in=[0-9A-Za-z]{43};/);
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/v1/sign-in", "Max-Age=43200"]) {
      assertStringIncludes(setCookie, attribute);
    }
    assert(!setCookie.includes("Secure"), "a plain HTTP request gets no Secure cookie");

    const httpsResponse = await sendRequest(identityService, "POST", "/v1/sign-in", {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { "x-forwarded-proto": "https" },
    });
    await httpsResponse.body?.cancel();
    assertStringIncludes(httpsResponse.headers.get("set-cookie")!, "Secure");

    for (
      const credentials of [
        { email: ADMIN_EMAIL, password: "wrong-password" },
        { email: "nobody@example.com", password: ADMIN_PASSWORD },
      ]
    ) {
      assertEquals(
        await expectErrorCode(
          sendRequest(identityService, "POST", "/v1/sign-in", { body: credentials }),
          401,
        ),
        "invalid_credentials",
      );
    }
  },
);

defineIdentityTest(
  "issues short-lived access tokens to a signed-in browser until it signs out",
  async ({ identityService, admin }) => {
    const tokenResponse = await expectJson<AccessTokenResponse>(admin.requestAccessToken(), 200);
    assertEquals(tokenResponse.projectId, null);
    assertEquals(tokenResponse.role, null);
    const issuedAt = Date.parse("2026-11-07T10:00:00Z");
    assert(Date.parse(tokenResponse.expiresAt) - issuedAt <= 400_000);
    const currentUser = await expectJson<User>(admin.send("GET", "/v1/me"), 200);
    assertEquals(currentUser.email, ADMIN_EMAIL);

    await expectJson(
      sendRequest(identityService, "DELETE", "/v1/sign-in", { cookie: admin.cookie }),
      204,
    );
    assertEquals(await expectErrorCode(admin.requestAccessToken(), 401), "unauthenticated");
    await expectJson(
      sendRequest(identityService, "POST", "/v1/sign-in/access-tokens", { body: {} }),
      401,
    );
  },
);

defineIdentityTest(
  "refuses local sign-in when local accounts are disabled",
  async ({ database, admin }) => {
    const identityService = createTestIdentityService(database, { areLocalAccountsEnabled: false });
    assertEquals(
      await expectErrorCode(
        sendRequest(identityService, "POST", "/v1/sign-in", {
          body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        }),
        403,
      ),
      "local_accounts_disabled",
    );
    await expectJson(
      sendRequest(identityService, "POST", "/v1/users", {
        bearerToken: admin.accessToken,
        body: { email: "new@example.com", displayName: "New", password: USER_PASSWORD },
      }),
      403,
    );
  },
);

defineIdentityTest("requires a user's access token", async ({ identityService, admin }) => {
  const { accessToken: serviceToken } = await expectJson<AccessTokenResponse>(
    requestServiceToken(identityService, {}),
    200,
  );
  const project = await createProject(admin, "checkout-bot");
  const { apiKey } = await createApiKey(admin, project.id, "CI pipeline");
  for (const bearerToken of [undefined, "wrong-token", apiKey, serviceToken]) {
    assertEquals(
      await expectErrorCode(
        sendRequest(identityService, "GET", "/v1/projects", { bearerToken }),
        401,
      ),
      "unauthenticated",
    );
  }
});

defineIdentityTest(
  "gives the first administrator the Role admin in the Projects that exist",
  async ({ database }) => {
    for (const tableName of IDENTITY_TABLES) {
      await database.orm.em.fork().execute(`delete from ${tableName}`);
    }
    const firstProject = await createFirstProjectIfNone(
      database,
      "bootstrap-key-with-at-least-thirty-two-characters",
    );
    const firstAdministrator = await createFirstAdministratorIfNone(
      database,
      { email: "First@Example.com", password: ADMIN_PASSWORD },
      { passwordHashIterations: PASSWORD_HASH_ITERATIONS },
    );
    assertEquals(firstAdministrator?.email, "first@example.com");
    assertEquals(
      await createFirstAdministratorIfNone(database, {
        email: "second@example.com",
        password: ADMIN_PASSWORD,
      }),
      null,
    );

    const identityService = createTestIdentityService(database);
    const admin = await signIn(identityService, "first@example.com", ADMIN_PASSWORD);
    const tokenResponse = await expectJson<AccessTokenResponse>(
      admin.requestAccessToken(firstProject!.id),
      200,
    );
    assertEquals(tokenResponse.role, "admin");
    const { groups } = await expectJson<{ groups: Group[] }>(admin.send("GET", "/v1/groups"), 200);
    assertEquals(groups.map((group) => [group.name, group.members.map(({ email }) => email)]), [
      ["Administrators", ["first@example.com"]],
    ]);
  },
);

defineIdentityTest(
  "lets only Instance admins manage Projects, users and Groups",
  async ({ identityService, admin }) => {
    const member = await createUser(admin, "member@example.com");
    const memberBrowser = await signIn(identityService, member.email, USER_PASSWORD);
    const project = await createProject(admin, "checkout-bot");

    for (
      const [method, path, body] of [
        ["POST", "/v1/projects", { name: "member-project" }],
        ["DELETE", `/v1/projects/${project.id}`, undefined],
        ["GET", "/v1/users", undefined],
        ["POST", "/v1/users", {
          email: "x@example.com",
          displayName: "X",
          password: USER_PASSWORD,
        }],
        ["PATCH", `/v1/users/${member.id}`, { isInstanceAdmin: true }],
        ["POST", "/v1/groups", { name: "Members" }],
        ["GET", `/v1/projects/${project.id}/role-assignments`, undefined],
        ["GET", `/v1/projects/${project.id}/api-keys`, undefined],
      ] as const
    ) {
      assertEquals(
        await expectErrorCode(memberBrowser.send(method, path, body), 403),
        "forbidden",
        `${method} ${path}`,
      );
    }
    // A user without a Role cannot see the Project at all.
    const { projects } = await expectJson<ListProjectsResponse>(
      memberBrowser.send("GET", "/v1/projects"),
      200,
    );
    assertEquals(projects, []);
    await expectJson(memberBrowser.send("GET", `/v1/projects/${project.id}`), 404);
    assertEquals(
      await expectErrorCode(memberBrowser.requestAccessToken(project.id), 403),
      "forbidden",
    );
    // Every signed-in user can list Groups, so that a Project admin can assign Roles.
    await expectJson(memberBrowser.send("GET", "/v1/groups"), 200);
  },
);

defineIdentityTest(
  "gives a user the highest Role of their Groups in a Project",
  async ({ identityService, admin }) => {
    const project = await createProject(admin, "checkout-bot");
    const otherProject = await createProject(admin, "assistant");
    const member = await createUser(admin, "member@example.com");
    await grantRole(admin, member, project.id, "viewer");
    const editors = await grantRole(admin, member, project.id, "editor");
    await grantRole(admin, member, otherProject.id, "viewer", "Assistant viewers");
    const memberBrowser = await signIn(identityService, member.email, USER_PASSWORD);

    const projectToken = await expectJson<AccessTokenResponse>(
      memberBrowser.requestAccessToken(project.id),
      200,
    );
    assertEquals([projectToken.projectId, projectToken.role], [project.id, "editor"]);
    const { projects } = await expectJson<ListProjectsResponse>(
      memberBrowser.send("GET", "/v1/projects"),
      200,
    );
    assertEquals(projects.map((listed) => [listed.name, listed.role]), [
      ["assistant", "viewer"],
      ["checkout-bot", "editor"],
    ]);

    // Without the editors' Group, the next token carries viewer.
    await expectJson(admin.send("DELETE", `/v1/groups/${editors.id}/members/${member.id}`), 200);
    const nextToken = await expectJson<AccessTokenResponse>(
      memberBrowser.requestAccessToken(project.id),
      200,
    );
    assertEquals(nextToken.role, "viewer");
  },
);

defineIdentityTest(
  "lets a Project's admin manage its Role assignments and API keys, not an editor",
  async ({ identityService, admin }) => {
    const project = await createProject(admin, "checkout-bot");
    const otherProject = await createProject(admin, "assistant");
    const projectAdmin = await createUser(admin, "lead@example.com");
    const editor = await createUser(admin, "editor@example.com");
    await grantRole(admin, projectAdmin, project.id, "admin");
    const editors = await grantRole(admin, editor, project.id, "editor");
    const projectAdminBrowser = await signIn(identityService, projectAdmin.email, USER_PASSWORD);
    const editorBrowser = await signIn(identityService, editor.email, USER_PASSWORD);

    await expectJson(
      projectAdminBrowser.send("PUT", `/v1/projects/${project.id}/role-assignments/${editors.id}`, {
        role: "viewer",
      }),
      200,
    );
    const { roleAssignments } = await expectJson<ListRoleAssignmentsResponse>(
      projectAdminBrowser.send("GET", `/v1/projects/${project.id}/role-assignments`),
      200,
    );
    assertEquals(
      roleAssignments.map((assignment) => [assignment.groupName, assignment.role]),
      [["editor@example.com editor", "viewer"], ["lead@example.com admin", "admin"]],
    );
    const { apiKey } = await createApiKey(projectAdminBrowser, project.id, "CI pipeline");
    assertEquals(await resolveApiKey(identityService, apiKey), project.id);

    await expectJson(
      editorBrowser.send("PUT", `/v1/projects/${project.id}/role-assignments/${editors.id}`, {
        role: "admin",
      }),
      403,
    );
    await expectJson(
      editorBrowser.send("POST", `/v1/projects/${project.id}/api-keys`, { name: "Mine" }),
      403,
    );
    // The Project admin's Role does not reach another Project.
    await expectJson(
      projectAdminBrowser.send("GET", `/v1/projects/${otherProject.id}/role-assignments`),
      403,
    );

    await expectJson(
      projectAdminBrowser.send(
        "DELETE",
        `/v1/projects/${project.id}/role-assignments/${editors.id}`,
      ),
      204,
    );
    assertEquals(
      await expectErrorCode(editorBrowser.requestAccessToken(project.id), 403),
      "forbidden",
    );
  },
);

defineIdentityTest("manages users and their deactivation", async ({ identityService, admin }) => {
  const member = await createUser(admin, "Member@Example.com");
  assertEquals(member.email, "member@example.com");
  assertEquals([member.isInstanceAdmin, member.isLocalAccount], [false, true]);
  assertEquals(
    await expectErrorCode(
      admin.send("POST", "/v1/users", {
        email: "member@example.com",
        displayName: "Again",
        password: USER_PASSWORD,
      }),
      409,
    ),
    "conflict",
  );
  await expectJson(
    admin.send("POST", "/v1/users", {
      email: "short@example.com",
      displayName: "S",
      password: "x",
    }),
    400,
  );
  const { users } = await expectJson<ListUsersResponse>(admin.send("GET", "/v1/users"), 200);
  assertEquals(users.map((user) => user.email), [ADMIN_EMAIL, "member@example.com"]);

  const memberBrowser = await signIn(identityService, member.email, USER_PASSWORD);
  const deactivated = await expectJson<User>(
    admin.send("PATCH", `/v1/users/${member.id}`, { isDeactivated: true }),
    200,
  );
  assert(deactivated.deactivatedAt !== null);
  // The sign-in ends at once, and so does the token's access to Identity.
  await expectJson(memberBrowser.requestAccessToken(), 401);
  await expectJson(memberBrowser.send("GET", "/v1/me"), 401);
  await expectJson(
    sendRequest(identityService, "POST", "/v1/sign-in", {
      body: { email: member.email, password: USER_PASSWORD },
    }),
    401,
  );

  await expectJson(
    admin.send("PATCH", `/v1/users/${member.id}`, {
      isDeactivated: false,
      password: "a-new-password-1",
      displayName: "Renamed",
    }),
    200,
  );
  await signIn(identityService, member.email, "a-new-password-1");
});

defineIdentityTest(
  "keeps at least one active Instance admin",
  async ({ identityService, admin }) => {
    const { id: adminId } = await expectJson<User>(admin.send("GET", "/v1/me"), 200);
    for (const change of [{ isInstanceAdmin: false }, { isDeactivated: true }]) {
      assertEquals(
        await expectErrorCode(admin.send("PATCH", `/v1/users/${adminId}`, change), 409),
        "conflict",
      );
    }
    const secondAdmin = await createUser(admin, "second@example.com", true);
    await expectJson(admin.send("PATCH", `/v1/users/${adminId}`, { isInstanceAdmin: false }), 200);
    const secondBrowser = await signIn(identityService, secondAdmin.email, USER_PASSWORD);
    await expectJson(secondBrowser.send("GET", "/v1/users"), 200);
    await expectJson(admin.send("GET", "/v1/users"), 403);
  },
);

defineIdentityTest("manages Groups and their members", async ({ admin }) => {
  const member = await createUser(admin, "member@example.com");
  const group = await expectJson<Group>(
    admin.send("POST", "/v1/groups", { name: " Support " }),
    201,
  );
  assertEquals([group.name, group.members], ["Support", []]);
  await expectJson(admin.send("POST", "/v1/groups", { name: "Support" }), 409);

  const withMember = await expectJson<Group>(
    admin.send("PUT", `/v1/groups/${group.id}/members/${member.id}`),
    200,
  );
  assertEquals(withMember.members.map(({ email }) => email), ["member@example.com"]);
  // Adding again is not an error, so that a retried request succeeds.
  await expectJson(admin.send("PUT", `/v1/groups/${group.id}/members/${member.id}`), 200);
  await expectJson(admin.send("PUT", `/v1/groups/${group.id}/members/unknown-user`), 404);
  await expectJson(admin.send("PUT", `/v1/groups/unknown-group/members/${member.id}`), 404);

  const project = await createProject(admin, "checkout-bot");
  await expectJson(
    admin.send("PUT", `/v1/projects/${project.id}/role-assignments/${group.id}`, {
      role: "editor",
    }),
    200,
  );
  await expectJson(admin.send("DELETE", `/v1/groups/${group.id}`), 204);
  await expectJson(admin.send("DELETE", `/v1/groups/${group.id}`), 404);
  const { roleAssignments } = await expectJson<ListRoleAssignmentsResponse>(
    admin.send("GET", `/v1/projects/${project.id}/role-assignments`),
    200,
  );
  assertEquals(roleAssignments, []);
});

defineIdentityTest(
  "issues service tokens that services verify with the published keys",
  async ({ identityService, admin }) => {
    const project = await createProject(admin, "checkout-bot");
    const tokenResponse = await expectJson<AccessTokenResponse>(
      requestServiceToken(identityService, { projectId: project.id }),
      200,
    );
    assertEquals([tokenResponse.projectId, tokenResponse.role], [project.id, "viewer"]);

    // What every service does: read the JWKS endpoint and verify the token locally.
    const verifier = createAccessTokenVerifier({
      readPublicKeySet: async () =>
        await (await sendRequest(identityService, "GET", "/internal/v1/jwks.json")).json(),
      // Near the test clock, which issued the token.
      readCurrentTime: () => new Date("2026-11-07T10:01:00Z"),
    });
    assertEquals(await verifier.verifyAccessToken(tokenResponse.accessToken), {
      subject: "service:evaluation",
      projectId: project.id,
      role: "viewer",
    });
    const { keys } = await expectJson<{ keys: { kty: string; alg: string; d?: string }[] }>(
      sendRequest(identityService, "GET", "/internal/v1/jwks.json"),
      200,
    );
    assertEquals(keys.map((key) => [key.kty, key.alg, key.d]), [["EC", "ES256", undefined]]);

    await expectJson(requestServiceToken(identityService, { projectId: "unknown" }), 404);
    for (
      const basicCredentials of [
        "evaluation:wrong-secret",
        `telemetry:${EVALUATION_CLIENT_SECRET}`,
        "no-separator",
      ]
    ) {
      await expectJson(requestServiceToken(identityService, {}, basicCredentials), 401);
    }
  },
);

defineIdentityTest(
  "resolves API keys only for services",
  async ({ identityService, admin }) => {
    const project = await createProject(admin, "checkout-bot");
    const { apiKey } = await createApiKey(admin, project.id, "CI pipeline");
    for (const bearerToken of [undefined, admin.accessToken]) {
      await expectJson(
        sendRequest(identityService, "POST", "/internal/v1/api-keys/resolve", {
          body: { apiKey },
          bearerToken,
        }),
        401,
      );
    }
    assertEquals(await resolveApiKey(identityService, apiKey), project.id);
  },
);

defineIdentityTest("creates and lists Projects by name", async ({ admin }) => {
  const checkoutProject = await createProject(admin, "  checkout-bot ");
  await createProject(admin, "assistant");

  assertEquals(checkoutProject.name, "checkout-bot");
  assertMatch(
    checkoutProject.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const { projects } = await expectJson<ListProjectsResponse>(
    admin.send("GET", "/v1/projects"),
    200,
  );
  // An Instance admin sees every Project, with no Role in the ones created later.
  assertEquals(projects.map((project) => [project.name, project.role]), [
    ["assistant", null],
    ["checkout-bot", null],
  ]);
  assertEquals(
    await expectJson<AccessibleProject>(
      admin.send("GET", `/v1/projects/${checkoutProject.id}`),
      200,
    ),
    { ...checkoutProject, role: null },
  );
});

defineIdentityTest("refuses a second Project with the same name", async ({ admin }) => {
  await createProject(admin, "checkout-bot");
  assertEquals(
    await expectErrorCode(admin.send("POST", "/v1/projects", { name: "checkout-bot" }), 409),
    "conflict",
  );
  for (const invalidName of ["", "   ", "x".repeat(65)]) {
    await expectJson(admin.send("POST", "/v1/projects", { name: invalidName }), 400);
  }
});

defineIdentityTest(
  "creates an API key that is shown once and resolves to its Project",
  async ({ identityService, admin }) => {
    const project = await createProject(admin, "checkout-bot");
    const createdKey = await createApiKey(admin, project.id, "CI pipeline");

    assertMatch(createdKey.apiKey, /^extispex_[0-9A-Za-z]{43}$/);
    assertEquals(createdKey.keyPrefix, createdKey.apiKey.slice(0, 17));
    assertEquals(createdKey.name, "CI pipeline");
    assertEquals(createdKey.revokedAt, null);
    assertEquals(await resolveApiKey(identityService, createdKey.apiKey), project.id);

    const { apiKeys } = await expectJson<ListApiKeysResponse>(
      admin.send("GET", `/v1/projects/${project.id}/api-keys`),
      200,
    );
    const { apiKey: _secretValue, ...listedKey } = createdKey;
    assertEquals(apiKeys, [listedKey]);
    assert(!JSON.stringify(apiKeys).includes(createdKey.apiKey));
  },
);

defineIdentityTest("does not resolve unknown keys", async ({ identityService }) => {
  assertEquals(await resolveApiKey(identityService, "extispex_unknown"), null);
  const { accessToken } = await expectJson<AccessTokenResponse>(
    requestServiceToken(identityService, {}),
    200,
  );
  await expectJson(
    sendRequest(identityService, "POST", "/internal/v1/api-keys/resolve", {
      body: { apiKey: "x".repeat(257) },
      bearerToken: accessToken,
    }),
    400,
  );
});

defineIdentityTest("stops resolving a revoked key", async ({ identityService, admin }) => {
  const project = await createProject(admin, "checkout-bot");
  const revokedKey = await createApiKey(admin, project.id, "Old laptop");
  const workingKey = await createApiKey(admin, project.id, "CI pipeline");
  const revokePath = `/v1/projects/${project.id}/api-keys/${revokedKey.id}`;

  await expectJson(admin.send("DELETE", revokePath), 204);
  // Revoking again is not an error, so that a retried request succeeds.
  await expectJson(admin.send("DELETE", revokePath), 204);

  assertEquals(await resolveApiKey(identityService, revokedKey.apiKey), null);
  assertEquals(await resolveApiKey(identityService, workingKey.apiKey), project.id);
  const { apiKeys } = await expectJson<ListApiKeysResponse>(
    admin.send("GET", `/v1/projects/${project.id}/api-keys`),
    200,
  );
  assertEquals(
    apiKeys.map((apiKey: ApiKey) => [apiKey.name, apiKey.revokedAt !== null]),
    [["CI pipeline", false], ["Old laptop", true]],
  );
});

defineIdentityTest("revokes keys only within their Project", async ({ identityService, admin }) => {
  const checkoutProject = await createProject(admin, "checkout-bot");
  const assistantProject = await createProject(admin, "assistant");
  const assistantKey = await createApiKey(admin, assistantProject.id, "CI pipeline");

  await expectJson(
    admin.send("DELETE", `/v1/projects/${checkoutProject.id}/api-keys/${assistantKey.id}`),
    404,
  );
  assertEquals(await resolveApiKey(identityService, assistantKey.apiKey), assistantProject.id);
});

defineIdentityTest(
  "stops a deleted Project's keys and frees its name",
  async ({ identityService, admin }) => {
    const project = await createProject(admin, "checkout-bot");
    const { apiKey } = await createApiKey(admin, project.id, "CI pipeline");

    await expectJson(admin.send("DELETE", `/v1/projects/${project.id}`), 204);

    assertEquals(await resolveApiKey(identityService, apiKey), null);
    await expectJson(admin.send("DELETE", `/v1/projects/${project.id}`), 404);
    await expectJson(admin.send("GET", `/v1/projects/${project.id}`), 404);
    await expectJson(
      admin.send("POST", `/v1/projects/${project.id}/api-keys`, { name: "Late" }),
      404,
    );
    await expectJson(admin.requestAccessToken(project.id), 404);
    await expectJson(requestServiceToken(identityService, { projectId: project.id }), 404);
    const { projects } = await expectJson<ListProjectsResponse>(
      admin.send("GET", "/v1/projects"),
      200,
    );
    assertEquals(projects, []);
    const recreatedProject = await createProject(admin, "checkout-bot");
    assert(recreatedProject.id !== project.id);
  },
);

defineIdentityTest(
  "creates the first Project only on an empty Instance",
  async ({ identityService, database, admin }) => {
    const bootstrapApiKey = "bootstrap-key-with-at-least-thirty-two-characters";
    const firstProject = await createFirstProjectIfNone(database, bootstrapApiKey);

    assert(firstProject !== null);
    assertEquals(firstProject.name, "Default");
    assertEquals(await resolveApiKey(identityService, bootstrapApiKey), firstProject.id);
    const { apiKeys } = await expectJson<ListApiKeysResponse>(
      admin.send("GET", `/v1/projects/${firstProject.id}/api-keys`),
      200,
    );
    assertEquals(apiKeys.map((apiKey) => apiKey.keyPrefix), ["bootstra"]);

    // Later starts change nothing, even after the first Project was deleted.
    assertEquals(
      await createFirstProjectIfNone(database, "another-key-of-thirty-two-chars!!"),
      null,
    );
    await expectJson(admin.send("DELETE", `/v1/projects/${firstProject.id}`), 204);
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
  const response = await sendRequest(identityService, "GET", "/openapi.json");
  const openApiDocument = await response.json();
  assertEquals(openApiDocument.openapi, "3.1.0");
  const documentedPaths = Object.keys(openApiDocument.paths);
  for (
    const expectedPath of [
      "/v1/projects/{projectId}/api-keys/{apiKeyId}",
      "/v1/projects/{projectId}/role-assignments/{groupId}",
      "/v1/sign-in/access-tokens",
      "/internal/v1/api-keys/resolve",
      "/internal/v1/service-tokens",
      "/internal/v1/jwks.json",
    ]
  ) {
    assert(documentedPaths.includes(expectedPath), expectedPath);
  }
});

defineIdentityTest("limits wrong passwords per account", async ({ identityService }) => {
  const attempt = (password: string) =>
    sendRequest(identityService, "POST", "/v1/sign-in", {
      body: { email: "guessed@example.com", password },
    });
  await createUser(
    await signIn(identityService, ADMIN_EMAIL, ADMIN_PASSWORD),
    "guessed@example.com",
  );
  for (let attemptNumber = 1; attemptNumber <= MAXIMUM_ATTEMPTS_PER_ACCOUNT; attemptNumber++) {
    await expectErrorCode(attempt("not-the-password"), 401);
  }
  // From here even the right password is refused, without computing its hash.
  const blockedResponse = await attempt(USER_PASSWORD);
  assertEquals(await expectErrorCode(Promise.resolve(blockedResponse), 429), "too_many_attempts");
  assert(Number(blockedResponse.headers.get("retry-after")) > 0);
});

defineIdentityTest(
  "throttles an unknown email the same way, so the answer reveals nothing",
  async ({ identityService }) => {
    const attempt = () =>
      sendRequest(identityService, "POST", "/v1/sign-in", {
        body: { email: "nobody@example.com", password: "not-the-password" },
      });
    for (let attemptNumber = 1; attemptNumber <= MAXIMUM_ATTEMPTS_PER_ACCOUNT; attemptNumber++) {
      assertEquals(await expectErrorCode(attempt(), 401), "invalid_credentials");
    }
    assertEquals(await expectErrorCode(attempt(), 429), "too_many_attempts");
  },
);

defineIdentityTest("forgets an account's wrong passwords after a right one", async (
  { identityService },
) => {
  for (let round = 1; round <= 3; round++) {
    for (let attemptNumber = 1; attemptNumber < MAXIMUM_ATTEMPTS_PER_ACCOUNT; attemptNumber++) {
      await expectErrorCode(
        sendRequest(identityService, "POST", "/v1/sign-in", {
          body: { email: ADMIN_EMAIL, password: "not-the-password" },
        }),
        401,
      );
    }
    await signIn(identityService, ADMIN_EMAIL, ADMIN_PASSWORD);
  }
});

defineIdentityTest("limits wrong passwords per address, across accounts", async (
  { identityService },
) => {
  const attemptFrom = (clientAddress: string, attemptNumber: number) =>
    sendRequest(identityService, "POST", "/v1/sign-in", {
      headers: { "x-forwarded-for": clientAddress },
      body: { email: `sprayed-${attemptNumber}@example.com`, password: "not-the-password" },
    });
  for (let attemptNumber = 1; attemptNumber <= MAXIMUM_ATTEMPTS_PER_ADDRESS; attemptNumber++) {
    await expectErrorCode(attemptFrom("203.0.113.7", attemptNumber), 401);
  }
  await expectErrorCode(attemptFrom("203.0.113.7", 0), 429);
  await expectErrorCode(attemptFrom("203.0.113.8", 0), 401);
});

defineIdentityTest("lets an account try again after the window ends", async ({ database }) => {
  let nowMilliseconds = Date.parse("2026-11-07T10:00:00Z");
  const identityService = createIdentityService({
    database,
    areLocalAccountsEnabled: true,
    serviceClientSecrets: new Map(),
    logger: createStructuredLogger("identity-test"),
    passwordHashIterations: PASSWORD_HASH_ITERATIONS,
    readCurrentTime: () => new Date(nowMilliseconds),
  });
  const attempt = (password: string) =>
    sendRequest(identityService, "POST", "/v1/sign-in", {
      body: { email: ADMIN_EMAIL, password },
    });
  for (let attemptNumber = 1; attemptNumber <= MAXIMUM_ATTEMPTS_PER_ACCOUNT; attemptNumber++) {
    await expectErrorCode(attempt("not-the-password"), 401);
  }
  await expectErrorCode(attempt(ADMIN_PASSWORD), 429);
  nowMilliseconds += (THROTTLE_WINDOW_SECONDS + 1) * 1000;
  await expectJson<User>(attempt(ADMIN_PASSWORD), 200);
});

defineIdentityTest("lets a user change their own password", async ({ identityService, admin }) => {
  const member = await createUser(admin, "changer@example.com");
  const firstBrowser = await signIn(identityService, member.email, USER_PASSWORD);
  const secondBrowser = await signIn(identityService, member.email, USER_PASSWORD);
  const changePassword = (cookie: string | undefined, currentPassword: string) =>
    sendRequest(identityService, "PUT", "/v1/sign-in/password", {
      cookie,
      body: { currentPassword, newPassword: "a-new-long-password" },
    });

  await expectErrorCode(changePassword(undefined, USER_PASSWORD), 401);
  await expectErrorCode(changePassword(firstBrowser.cookie, "not-the-password"), 403);
  await expectErrorCode(
    sendRequest(identityService, "PUT", "/v1/sign-in/password", {
      cookie: firstBrowser.cookie,
      body: { currentPassword: USER_PASSWORD, newPassword: "short" },
    }),
    400,
  );
  await expectJson(changePassword(firstBrowser.cookie, USER_PASSWORD), 204);

  await expectJson<AccessTokenResponse>(firstBrowser.requestAccessToken(), 200);
  await expectErrorCode(secondBrowser.requestAccessToken(), 401);
  await expectErrorCode(
    sendRequest(identityService, "POST", "/v1/sign-in", {
      body: { email: member.email, password: USER_PASSWORD },
    }),
    401,
  );
  await signIn(identityService, member.email, "a-new-long-password");
});

defineIdentityTest("keeps Company groups on a Group, for Instance admins only", async (
  { identityService, admin },
) => {
  const group = await expectJson<Group>(admin.send("POST", "/v1/groups", { name: "Support" }), 201);
  assertEquals(group.companyGroups, []);
  const updated = await expectJson<Group>(
    admin.send("PUT", `/v1/groups/${group.id}/company-groups`, {
      companyGroups: ["team-support", " CN=Support,OU=Teams ", "team-support"],
    }),
    200,
  );
  assertEquals(updated.companyGroups, ["CN=Support,OU=Teams", "team-support"]);
  const { groups } = await expectJson<{ groups: Group[] }>(admin.send("GET", "/v1/groups"), 200);
  assertEquals(
    groups.find(({ id }) => id === group.id)?.companyGroups,
    ["CN=Support,OU=Teams", "team-support"],
  );
  await expectJson(
    admin.send("PUT", "/v1/groups/unknown-group/company-groups", { companyGroups: [] }),
    404,
  );
  await createUser(admin, "plain@example.com");
  const plainUser = await signIn(identityService, "plain@example.com", USER_PASSWORD);
  await expectErrorCode(
    plainUser.send("PUT", `/v1/groups/${group.id}/company-groups`, { companyGroups: [] }),
    403,
  );
  // Deleting the Group removes its mappings with it.
  await expectJson(admin.send("DELETE", `/v1/groups/${group.id}`), 204);
});
