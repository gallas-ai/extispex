import { assert, assertEquals } from "@std/assert";
import type {
  AccessibleProject,
  AccessTokenResponse,
  CreatedApiKey,
  Group,
  ListDeletedProjectsResponse,
  ListUsersResponse,
  Project,
  ProjectLifecycle,
  User,
} from "@extispex/contracts";
import { createStructuredLogger, generateMasterKey } from "@extispex/service-runtime";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  createFirstAdministratorIfNone,
  createIdentityService,
  type IdentityDatabase,
  type IdentityService,
  openIdentityDatabase,
} from "../src/create-service.ts";
import { createSigningKeyCipher } from "../src/access-tokens/signing-keys.ts";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const TELEMETRY_SECRET = "telemetry-client-secret-with-enough-characters";
const REPORTING_SECRET = "reporting-client-secret-with-enough-characters";
const MINUTE = 60_000;
const DAY = 86_400_000;
const INTERVAL = 10 * MINUTE;
const SIGNING_KEY_CIPHER = await createSigningKeyCipher(generateMasterKey());

const IDENTITY_TABLES = [
  "company_group_members",
  "company_groups",
  "sign_in_throttles",
  "sign_ins",
  "group_members",
  "role_assignments",
  "groups",
  "users",
  "project_data_removals",
  "background_leases",
  "api_keys",
  "projects",
  "signing_keys",
];

/** A clock that only moves when the test moves it. */
interface TestClock {
  now(): Date;
  advance(milliseconds: number): void;
}

interface LifecycleTestContext {
  database: IdentityDatabase;
  clock: TestClock;
  createService(leaseHolder: string): IdentityService;
  identityService: IdentityService;
  /** Sends a request with a fresh access token of the first administrator. */
  sendAsAdmin(method: string, path: string, body?: unknown): Promise<Response>;
}

function defineLifecycleTest(
  testName: string,
  testBody: (context: LifecycleTestContext) => Promise<void>,
): void {
  for (const testDatabase of listTestDatabases("identity")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openIdentityDatabase(testDatabase.url);
      try {
        for (const tableName of IDENTITY_TABLES) {
          await database.orm.em.fork().execute(`delete from ${tableName}`);
        }
        await createFirstAdministratorIfNone(
          database,
          { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
          { passwordHashIterations: 1_000 },
        );
        let clockMilliseconds = Date.parse("2026-11-11T10:00:00Z");
        const clock: TestClock = {
          now: () => new Date(clockMilliseconds),
          advance: (milliseconds) => clockMilliseconds += milliseconds,
        };
        const createService = (leaseHolder: string) =>
          createIdentityService({
            database,
            signingKeyCipher: SIGNING_KEY_CIPHER,
            areLocalAccountsEnabled: true,
            serviceClientSecrets: new Map([
              ["telemetry", TELEMETRY_SECRET],
              ["reporting", REPORTING_SECRET],
            ]),
            logger: createStructuredLogger("identity-test"),
            passwordHashIterations: 1_000,
            readCurrentTime: clock.now,
            dataLifecycleIntervalMilliseconds: INTERVAL,
            leaseHolder,
          });
        const identityService = createService("replica-one");
        const sendAsAdmin = async (method: string, path: string, body?: unknown) => {
          const accessToken = await signInAs(identityService, ADMIN_EMAIL, ADMIN_PASSWORD);
          return await send(identityService, method, path, { bearerToken: accessToken, body });
        };
        await testBody({ database, clock, createService, identityService, sendAsAdmin });
      } finally {
        await database.close();
      }
    });
  }
}

function send(
  identityService: IdentityService,
  method: string,
  path: string,
  options: { bearerToken?: string; basicCredentials?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.bearerToken !== undefined) {
    headers.set("authorization", `Bearer ${options.bearerToken}`);
  }
  if (options.basicCredentials !== undefined) {
    headers.set("authorization", `Basic ${btoa(options.basicCredentials)}`);
  }
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return Promise.resolve(identityService.handleRequest(
    new Request(`http://identity.test${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  ));
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

async function signInAs(
  identityService: IdentityService,
  email: string,
  password: string,
  projectId?: string,
): Promise<string> {
  const signInResponse = await send(identityService, "POST", "/v1/sign-in", {
    body: { email, password },
  });
  await expectJson(Promise.resolve(signInResponse), 200);
  const cookie = signInResponse.headers.get("set-cookie")!.split(";")[0];
  const tokenResponse = await identityService.handleRequest(
    new Request("http://identity.test/v1/sign-in/access-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(projectId === undefined ? {} : { projectId }),
    }),
  );
  return (await expectJson<AccessTokenResponse>(Promise.resolve(tokenResponse), 200)).accessToken;
}

async function readServiceToken(
  identityService: IdentityService,
  basicCredentials = `telemetry:${TELEMETRY_SECRET}`,
): Promise<string> {
  const response = send(identityService, "POST", "/internal/v1/service-tokens", {
    basicCredentials,
    body: {},
  });
  return (await expectJson<AccessTokenResponse>(response, 200)).accessToken;
}

async function readLifecycle(identityService: IdentityService): Promise<ProjectLifecycle> {
  return await expectJson<ProjectLifecycle>(
    send(identityService, "GET", "/internal/v1/project-lifecycle", {
      bearerToken: await readServiceToken(identityService),
    }),
    200,
  );
}

async function recordRemoval(identityService: IdentityService, projectId: string) {
  await expectJson(
    send(identityService, "PUT", `/internal/v1/deleted-projects/${projectId}/data-removal`, {
      bearerToken: await readServiceToken(identityService),
    }),
    204,
  );
}

async function createUserWithRole(
  sendAsAdmin: LifecycleTestContext["sendAsAdmin"],
  email: string,
  projectId: string,
  role: string,
): Promise<{ user: User; group: Group }> {
  const user = await expectJson<User>(
    sendAsAdmin("POST", "/v1/users", { email, displayName: "Ada", password: "a-user-password" }),
    201,
  );
  const group = await expectJson<Group>(
    sendAsAdmin("POST", "/v1/groups", { name: `${email} group` }),
    201,
  );
  await expectJson(sendAsAdmin("PUT", `/v1/groups/${group.id}/members/${user.id}`), 200);
  await expectJson(
    sendAsAdmin("PUT", `/v1/projects/${projectId}/role-assignments/${group.id}`, { role }),
    200,
  );
  return { user, group };
}

defineLifecycleTest(
  "keeps a Retention Period per Project, set by its admins",
  async ({ identityService, sendAsAdmin }) => {
    const project = await expectJson<Project>(
      sendAsAdmin("POST", "/v1/projects", { name: "checkout" }),
      201,
    );
    assertEquals(project.retentionDays, 30);
    await createUserWithRole(sendAsAdmin, "viewer@example.com", project.id, "viewer");
    await createUserWithRole(sendAsAdmin, "owner@example.com", project.id, "admin");

    const viewerToken = await signInAs(identityService, "viewer@example.com", "a-user-password");
    await expectJson(
      send(identityService, "PATCH", `/v1/projects/${project.id}`, {
        bearerToken: viewerToken,
        body: { retentionDays: 7 },
      }),
      403,
    );
    const ownerToken = await signInAs(identityService, "owner@example.com", "a-user-password");
    for (const invalidDays of [0, 401, 1.5]) {
      await expectJson(
        send(identityService, "PATCH", `/v1/projects/${project.id}`, {
          bearerToken: ownerToken,
          body: { retentionDays: invalidDays },
        }),
        400,
      );
    }
    const changedProject = await expectJson<AccessibleProject>(
      send(identityService, "PATCH", `/v1/projects/${project.id}`, {
        bearerToken: ownerToken,
        body: { retentionDays: 7 },
      }),
      200,
    );
    assertEquals(changedProject.retentionDays, 7);
    assertEquals(changedProject.role, "admin");

    const lifecycle = await readLifecycle(identityService);
    assertEquals(
      lifecycle.projects.find((retention) => retention.projectId === project.id)?.retentionDays,
      7,
    );
    assertEquals(lifecycle.projectsToRemove, []);
    await expectJson(
      send(identityService, "GET", "/internal/v1/project-lifecycle", { bearerToken: ownerToken }),
      401,
    );
  },
);

defineLifecycleTest(
  "lists a deleted Project to a service until it removed the data after every token expired",
  async ({ identityService, clock, sendAsAdmin }) => {
    const project = await expectJson<Project>(
      sendAsAdmin("POST", "/v1/projects", { name: "to-delete" }),
      201,
    );
    await expectJson(sendAsAdmin("DELETE", `/v1/projects/${project.id}`), 204);
    assertEquals(
      (await readLifecycle(identityService)).projectsToRemove.map(({ projectId }) => projectId),
      [project.id],
    );
    assert(
      !(await readLifecycle(identityService)).projects.some(({ projectId }) =>
        projectId === project.id
      ),
    );

    // A token issued before the deletion still works for five minutes, so a removal this early
    // may miss data written with it, and the service is asked again.
    clock.advance(MINUTE);
    await recordRemoval(identityService, project.id);
    assertEquals((await readLifecycle(identityService)).projectsToRemove.length, 1);
    let { deletedProjects } = await expectJson<ListDeletedProjectsResponse>(
      sendAsAdmin("GET", "/v1/deleted-projects"),
      200,
    );
    const telemetryRemoval = () =>
      deletedProjects[0].dataRemovals.find((removal) => removal.service === "telemetry")!;
    assertEquals(deletedProjects[0].id, project.id);
    assertEquals(
      deletedProjects[0].dataRemovals.map((removal) => removal.service),
      ["identity", "telemetry", "prompt", "evaluation"],
    );
    assertEquals(telemetryRemoval().removedAt, clock.now().toISOString());
    assertEquals(telemetryRemoval().isComplete, false);

    clock.advance(5 * MINUTE);
    await recordRemoval(identityService, project.id);
    assertEquals((await readLifecycle(identityService)).projectsToRemove, []);
    ({ deletedProjects } = await expectJson<ListDeletedProjectsResponse>(
      sendAsAdmin("GET", "/v1/deleted-projects"),
      200,
    ));
    assertEquals(telemetryRemoval().isComplete, true);
    assertEquals(
      deletedProjects[0].dataRemovals.find((removal) => removal.service === "prompt")!.removedAt,
      null,
    );
  },
);

defineLifecycleTest(
  "accepts data removals only from services that keep Project data, for deleted Projects",
  async ({ identityService, sendAsAdmin }) => {
    const project = await expectJson<Project>(
      sendAsAdmin("POST", "/v1/projects", { name: "kept" }),
      201,
    );
    await expectJson(
      send(identityService, "PUT", `/internal/v1/deleted-projects/${project.id}/data-removal`, {
        bearerToken: await readServiceToken(identityService),
      }),
      404,
    );
    await expectJson(sendAsAdmin("DELETE", `/v1/projects/${project.id}`), 204);
    await expectJson(
      send(identityService, "PUT", `/internal/v1/deleted-projects/${project.id}/data-removal`, {
        bearerToken: await readServiceToken(identityService, `reporting:${REPORTING_SECRET}`),
      }),
      403,
    );
    const userToken = await signInAs(identityService, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expectJson(
      send(identityService, "PUT", `/internal/v1/deleted-projects/${project.id}/data-removal`, {
        bearerToken: userToken,
      }),
      401,
    );
    await expectJson(
      send(identityService, "GET", "/v1/deleted-projects", { bearerToken: userToken }),
      200,
    );
  },
);

defineLifecycleTest(
  "removes its own data of a deleted Project in the periodic run, on one replica at a time",
  async ({ identityService, createService, clock, sendAsAdmin, database }) => {
    const project = await expectJson<Project>(
      sendAsAdmin("POST", "/v1/projects", { name: "with-keys" }),
      201,
    );
    const apiKey = await expectJson<CreatedApiKey>(
      sendAsAdmin("POST", `/v1/projects/${project.id}/api-keys`, { name: "ci" }),
      201,
    );
    await createUserWithRole(sendAsAdmin, "member@example.com", project.id, "editor");
    await expectJson(sendAsAdmin("DELETE", `/v1/projects/${project.id}`), 204);
    const secondReplica = createService("replica-two");

    assertEquals(await identityService.runDataLifecycle(), {
      status: "ran",
      removedProjectIds: [project.id],
      deletedUserCount: 0,
    });
    assertEquals(await secondReplica.runDataLifecycle(), { status: "skipped" });
    const countRows = async (tableName: string) =>
      Number(
        (await database.orm.em.fork().execute<{ row_count: number | string }[]>(
          `select count(*) as row_count from ${tableName} where project_id = ?`,
          [project.id],
        ))[0].row_count,
      );
    assertEquals(await countRows("api_keys"), 0);
    assertEquals(await countRows("role_assignments"), 0);
    assert(apiKey.apiKey.length > 0);

    // The lease lasts two intervals; the replica that holds it renews it on every run. This run
    // comes after every token for the Project expired, so its removal is final.
    clock.advance(INTERVAL);
    assertEquals(await identityService.runDataLifecycle(), {
      status: "ran",
      removedProjectIds: [project.id],
      deletedUserCount: 0,
    });
    const finalRemovalTime = clock.now().toISOString();
    clock.advance(INTERVAL + MINUTE);
    assertEquals(await secondReplica.runDataLifecycle(), { status: "skipped" });
    clock.advance(2 * INTERVAL);
    assertEquals(await secondReplica.runDataLifecycle(), {
      status: "ran",
      removedProjectIds: [],
      deletedUserCount: 0,
    });
    assertEquals(await identityService.runDataLifecycle(), { status: "skipped" });
    const { deletedProjects } = await expectJson<ListDeletedProjectsResponse>(
      sendAsAdmin("GET", "/v1/deleted-projects"),
      200,
    );
    assertEquals(deletedProjects[0].dataRemovals[0], {
      service: "identity",
      removedAt: finalRemovalTime,
      isComplete: true,
    });
  },
);

defineLifecycleTest(
  "deletes a deactivated user's personal data 30 days after deactivation and keeps the ID",
  async ({ identityService, clock, sendAsAdmin, database }) => {
    const project = await expectJson<Project>(
      sendAsAdmin("POST", "/v1/projects", { name: "people" }),
      201,
    );
    const { user, group } = await createUserWithRole(
      sendAsAdmin,
      "grace@example.com",
      project.id,
      "viewer",
    );
    const { user: stayingUser } = await createUserWithRole(
      sendAsAdmin,
      "alan@example.com",
      project.id,
      "viewer",
    );
    await expectJson(sendAsAdmin("PATCH", `/v1/users/${user.id}`, { isDeactivated: true }), 200);

    clock.advance(29 * DAY);
    assertEquals((await identityService.runDataLifecycle()).status, "ran");
    let { users } = await expectJson<ListUsersResponse>(sendAsAdmin("GET", "/v1/users"), 200);
    assertEquals(users.find((listed) => listed.id === user.id)?.email, "grace@example.com");

    clock.advance(DAY + MINUTE);
    const outcome = await identityService.runDataLifecycle();
    assert(outcome.status === "ran");
    assertEquals(outcome.deletedUserCount, 1);
    ({ users } = await expectJson<ListUsersResponse>(sendAsAdmin("GET", "/v1/users"), 200));
    const deletedUser = users.find((listed) => listed.id === user.id)!;
    assertEquals(deletedUser.displayName, "Deleted user");
    assertEquals(deletedUser.email, `deleted-user-${user.id}@deleted.invalid`);
    assertEquals(deletedUser.isLocalAccount, false);
    assertEquals(deletedUser.personalDataDeletedAt, clock.now().toISOString());
    assertEquals(users.find((listed) => listed.id === stayingUser.id)?.personalDataDeletedAt, null);

    const groups = await expectJson<{ groups: Group[] }>(sendAsAdmin("GET", "/v1/groups"), 200);
    assertEquals(
      groups.groups.find((listed) => listed.id === group.id)?.members.map((member) => member.id),
      [],
    );
    const storedRows = await database.orm.em.fork().execute<Record<string, unknown>[]>(
      "select password_hash, oidc_issuer, directory_user_name from users where id = ?",
      [user.id],
    );
    assertEquals(storedRows[0], {
      password_hash: null,
      oidc_issuer: null,
      directory_user_name: null,
    });
    await expectJson(
      sendAsAdmin("PATCH", `/v1/users/${user.id}`, { isDeactivated: false }),
      409,
    );
    // The address is free again for a new user.
    await expectJson(
      sendAsAdmin("POST", "/v1/users", {
        email: "grace@example.com",
        displayName: "Grace",
        password: "a-user-password",
      }),
      201,
    );
  },
);
