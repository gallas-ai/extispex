/**
 * The company's directory over SCIM 2.0 and imported files: users and Company groups arrive,
 * mapped Company groups move people in and out of Groups, and removed users lose their access.
 */
import { assert, assertEquals } from "@std/assert";
import type {
  AccessTokenResponse,
  CreatedDirectoryToken,
  DirectoryImportFailure,
  DirectoryImportSummary,
  DirectoryStatus,
  Group,
  ListUsersResponse,
  User,
} from "@extispex/contracts";
import { createStructuredLogger } from "@extispex/service-runtime";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  createFirstAdministratorIfNone,
  createIdentityService,
  type IdentityService,
  openIdentityDatabase,
} from "../src/create-service.ts";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const PASSWORD_HASH_ITERATIONS = 1_000;

const DIRECTORY_TABLES = [
  "company_group_members",
  "company_groups",
  "directory_tokens",
  "directory_imports",
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

interface ScimResource {
  id: string;
  [attributeName: string]: unknown;
}

interface ScimList {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: ScimResource[];
}

interface ScimError {
  schemas: string[];
  status: string;
  scimType?: string;
  detail: string;
}

interface DirectoryTestContext {
  identityService: IdentityService;
  /** Sends a request with the first administrator's access token. */
  sendAsAdmin(method: string, path: string, body?: unknown): Promise<Response>;
  /** Sends a SCIM request with a directory token. */
  sendScim(method: string, path: string, body?: unknown): Promise<Response>;
  directoryToken: CreatedDirectoryToken;
}

function defineDirectoryTest(
  testName: string,
  testBody: (context: DirectoryTestContext) => Promise<void>,
) {
  for (const testDatabase of listTestDatabases("identity")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openIdentityDatabase(testDatabase.url);
      try {
        for (const tableName of DIRECTORY_TABLES) {
          await database.orm.em.fork().execute(`delete from ${tableName}`);
        }
        await createFirstAdministratorIfNone(
          database,
          { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
          { passwordHashIterations: PASSWORD_HASH_ITERATIONS },
        );
        let clockMilliseconds = Date.parse("2026-11-10T10:00:00Z");
        const identityService = createIdentityService({
          database,
          areLocalAccountsEnabled: true,
          serviceClientSecrets: new Map(),
          logger: createStructuredLogger("identity-test"),
          passwordHashIterations: PASSWORD_HASH_ITERATIONS,
          readCurrentTime: () => new Date(clockMilliseconds += 1_000),
        });
        const adminToken = await signIn(identityService, ADMIN_EMAIL, ADMIN_PASSWORD);
        const sendAsAdmin = (method: string, path: string, body?: unknown) =>
          send(identityService, method, path, { bearerToken: adminToken, body });
        const directoryToken = await expectJson<CreatedDirectoryToken>(
          sendAsAdmin("POST", "/v1/directory/tokens", { name: "Entra" }),
          201,
        );
        await testBody({
          identityService,
          sendAsAdmin,
          sendScim: (method, path, body) =>
            send(identityService, method, `/scim/v2${path}`, {
              bearerToken: directoryToken.token,
              body,
              contentType: "application/scim+json",
            }),
          directoryToken,
        });
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
  options: { body?: unknown; bearerToken?: string; contentType?: string; cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.bearerToken !== undefined) {
    headers.set("authorization", `Bearer ${options.bearerToken}`);
  }
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  const isText = typeof options.body === "string";
  if (options.body !== undefined) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  return Promise.resolve(identityService.handleRequest(
    new Request(`http://identity.test${path}`, {
      method,
      headers,
      body: options.body === undefined
        ? undefined
        : isText
        ? options.body as string
        : JSON.stringify(options.body),
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

async function signIn(
  identityService: IdentityService,
  email: string,
  password: string,
): Promise<string> {
  const response = await send(identityService, "POST", "/v1/sign-in", {
    body: { email, password },
  });
  assertEquals(response.status, 200, await response.clone().text());
  await response.body?.cancel();
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const { accessToken } = await expectJson<AccessTokenResponse>(
    send(identityService, "POST", "/v1/sign-in/access-tokens", { cookie, body: {} }),
    200,
  );
  return accessToken;
}

function createScimUser(context: DirectoryTestContext, userName: string, extra = {}) {
  return expectJson<ScimResource>(
    context.sendScim("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName,
      name: { givenName: "Grace", familyName: "Hopper" },
      emails: [{ value: userName, type: "work", primary: true }],
      active: true,
      ...extra,
    }),
    201,
  );
}

function createScimGroup(context: DirectoryTestContext, displayName: string, memberIds: string[]) {
  return expectJson<ScimResource>(
    context.sendScim("POST", "/Groups", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName,
      members: memberIds.map((value) => ({ value })),
    }),
    201,
  );
}

async function createMappedGroup(
  context: DirectoryTestContext,
  name: string,
  companyGroups: string[],
): Promise<Group> {
  const group = await expectJson<Group>(context.sendAsAdmin("POST", "/v1/groups", { name }), 201);
  return await expectJson<Group>(
    context.sendAsAdmin("PUT", `/v1/groups/${group.id}/company-groups`, { companyGroups }),
    200,
  );
}

async function readMemberEmails(context: DirectoryTestContext, groupId: string) {
  const { groups } = await expectJson<{ groups: Group[] }>(
    context.sendAsAdmin("GET", "/v1/groups"),
    200,
  );
  return groups.find((group) => group.id === groupId)!.members.map((member) => member.email);
}

async function findUser(context: DirectoryTestContext, email: string): Promise<User> {
  const { users } = await expectJson<ListUsersResponse>(
    context.sendAsAdmin("GET", "/v1/users"),
    200,
  );
  return users.find((user) => user.email === email)!;
}

defineDirectoryTest("refuses SCIM requests without a valid directory token", async (context) => {
  for (const bearerToken of [undefined, "extispex_wrong", context.directoryToken.token]) {
    const response = await send(context.identityService, "GET", "/scim/v2/Users", {
      bearerToken,
    });
    if (bearerToken === context.directoryToken.token) {
      assertEquals(response.status, 200);
      await response.body?.cancel();
      continue;
    }
    assertEquals(response.status, 401);
    assertEquals(response.headers.get("content-type"), "application/scim+json");
    assertEquals((await response.json() as ScimError).status, "401");
  }
  // A user's access token is not a directory token.
  const adminResponse = await context.sendAsAdmin("GET", "/scim/v2/Users");
  assertEquals(adminResponse.status, 401);
  await adminResponse.body?.cancel();

  await expectJson(
    context.sendAsAdmin("DELETE", `/v1/directory/tokens/${context.directoryToken.id}`),
    204,
  );
  const revokedResponse = await context.sendScim("GET", "/Users");
  assertEquals(revokedResponse.status, 401);
  await revokedResponse.body?.cancel();
  const status = await expectJson<DirectoryStatus>(
    context.sendAsAdmin("GET", "/v1/directory"),
    200,
  );
  assert(status.tokens[0].revokedAt !== null);
  assert(status.tokens[0].lastUsedAt !== null);
  assertEquals(status.lastScimRequestAt, status.tokens[0].lastUsedAt);
});

defineDirectoryTest("describes itself for the directory's discovery", async (context) => {
  const config = await expectJson<{ patch: { supported: boolean } }>(
    context.sendScim("GET", "/ServiceProviderConfig"),
    200,
  );
  assertEquals(config.patch.supported, true);
  const resourceTypes = await expectJson<ScimList>(context.sendScim("GET", "/ResourceTypes"), 200);
  assertEquals(resourceTypes.Resources.map((resource) => resource.id), ["User", "Group"]);
  const schemas = await expectJson<ScimList>(context.sendScim("GET", "/Schemas"), 200);
  assertEquals(schemas.totalResults, 2);
});

defineDirectoryTest("creates, finds, changes and pages users", async (context) => {
  const grace = await createScimUser(context, "Grace@Example.com", { externalId: "entra-1" });
  assertEquals(grace.userName, "grace@example.com");
  assertEquals(grace.displayName, "Grace Hopper");
  assertEquals(grace.active, true);

  const byUserName = await expectJson<ScimList>(
    context.sendScim(
      "GET",
      `/Users?filter=${encodeURIComponent('userName eq "GRACE@example.com"')}`,
    ),
    200,
  );
  assertEquals(byUserName.Resources.map((resource) => resource.id), [grace.id]);
  const byExternalId = await expectJson<ScimList>(
    context.sendScim("GET", `/Users?filter=${encodeURIComponent('externalId eq "entra-1"')}`),
    200,
  );
  assertEquals(byExternalId.totalResults, 1);
  const unsupported = await expectJson<ScimError>(
    context.sendScim("GET", `/Users?filter=${encodeURIComponent('title co "x"')}`),
    400,
  );
  assertEquals(unsupported.scimType, "invalidFilter");

  // A second POST of the same person is a conflict, as RFC 7644 requires.
  const duplicate = await expectJson<ScimError>(
    context.sendScim("POST", "/Users", { userName: "grace@example.com" }),
    409,
  );
  assertEquals(duplicate.scimType, "uniqueness");

  const replaced = await expectJson<ScimResource>(
    context.sendScim("PUT", `/Users/${grace.id}`, {
      userName: "grace@example.com",
      displayName: "Rear Admiral Hopper",
      emails: [{ value: "grace.hopper@example.com", primary: true }],
    }),
    200,
  );
  assertEquals(replaced.displayName, "Rear Admiral Hopper");
  assertEquals(replaced.emails, [{
    value: "grace.hopper@example.com",
    primary: true,
    type: "work",
  }]);
  // Without `active` the PUT keeps the user active.
  assertEquals(replaced.active, true);

  await createScimUser(context, "alan@example.com");
  await createScimUser(context, "ada@example.com");
  const secondPage = await expectJson<ScimList>(
    context.sendScim("GET", "/Users?startIndex=2&count=1"),
    200,
  );
  assertEquals(
    [secondPage.totalResults, secondPage.startIndex, secondPage.itemsPerPage],
    [3, 2, 1],
  );
  const user = await findUser(context, "grace.hopper@example.com");
  assertEquals([user.directorySource, user.isLocalAccount], ["scim", false]);
});

defineDirectoryTest("applies Microsoft Entra's PATCH dialect", async (context) => {
  const grace = await createScimUser(context, "grace@example.com");
  const patched = await expectJson<ScimResource>(
    context.sendScim("PATCH", `/Users/${grace.id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [
        { op: "Replace", path: "displayName", value: "Grace B. Hopper" },
        { op: "Add", path: 'emails[type eq "work"].value', value: "gbh@example.com" },
        { op: "Replace", value: { externalId: "entra-7" } },
        // Permissions are never imported: a role is ignored.
        { op: "Add", path: "roles", value: [{ value: "admin" }] },
      ],
    }),
    200,
  );
  assertEquals(patched.displayName, "Grace B. Hopper");
  assertEquals(patched.externalId, "entra-7");
  assertEquals(patched.emails, [{ value: "gbh@example.com", primary: true, type: "work" }]);
  const deactivated = await expectJson<ScimResource>(
    context.sendScim("PATCH", `/Users/${grace.id}`, {
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    }),
    200,
  );
  assertEquals(deactivated.active, false);
  const user = await findUser(context, "gbh@example.com");
  assert(user.deactivatedAt !== null);
  assertEquals(user.isInstanceAdmin, false);

  const invalid = await expectJson<ScimError>(
    context.sendScim("PATCH", `/Users/${grace.id}`, {
      Operations: [{ op: "replace", path: "active", value: "maybe" }],
    }),
    400,
  );
  assertEquals(invalid.scimType, "invalidValue");
  const malformed = await context.identityService.handleRequest(
    new Request(`http://identity.test/scim/v2/Users/${grace.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${context.directoryToken.token}`,
        "content-type": "application/scim+json",
      },
      body: "{not json",
    }),
  );
  assertEquals(malformed.status, 400);
  assertEquals((await malformed.json() as ScimError).scimType, "invalidSyntax");
});

defineDirectoryTest("keeps local accounts out of the directory's reach", async (context) => {
  const listed = await expectJson<ScimList>(context.sendScim("GET", "/Users"), 200);
  assertEquals(listed.totalResults, 0);
  const admin = await findUser(context, ADMIN_EMAIL);
  await expectJson(context.sendScim("GET", `/Users/${admin.id}`), 404);
  await expectJson(context.sendScim("DELETE", `/Users/${admin.id}`), 404);
  const takeover = await expectJson<ScimError>(
    context.sendScim("POST", "/Users", { userName: ADMIN_EMAIL }),
    409,
  );
  assertEquals(takeover.scimType, "uniqueness");
  const groupWithAdmin = await expectJson<ScimError>(
    context.sendScim("POST", "/Groups", { displayName: "admins", members: [{ value: admin.id }] }),
    400,
  );
  assertEquals(groupWithAdmin.scimType, "invalidValue");
});

defineDirectoryTest("moves members of a mapped Company group in and out of the Group", async (
  context,
) => {
  const grace = await createScimUser(context, "grace@example.com");
  const alan = await createScimUser(context, "alan@example.com");
  const engineers = await createMappedGroup(context, "Engineers", ["team-engineering"]);
  const engineering = await createScimGroup(context, "team-engineering", [grace.id]);
  assertEquals(await readMemberEmails(context, engineers.id), ["grace@example.com"]);

  await expectJson(
    context.sendScim("PATCH", `/Groups/${engineering.id}`, {
      Operations: [
        { op: "add", path: "members", value: [{ value: alan.id }] },
        { op: "remove", path: `members[value eq "${grace.id}"]` },
      ],
    }),
    200,
  );
  assertEquals(await readMemberEmails(context, engineers.id), ["alan@example.com"]);
  // Microsoft Entra removes a member with the list in the value instead of a filter.
  await expectJson(
    context.sendScim("PATCH", `/Groups/${engineering.id}`, {
      Operations: [{ op: "Remove", path: "members", value: [{ value: alan.id }] }],
    }),
    200,
  );
  assertEquals(await readMemberEmails(context, engineers.id), []);

  // A member added by hand stays when the directory removes them from the Company group.
  await expectJson(
    context.sendScim("PUT", `/Groups/${engineering.id}`, {
      displayName: "team-engineering",
      members: [{ value: grace.id }],
    }),
    200,
  );
  await expectJson(
    context.sendAsAdmin("PUT", `/v1/groups/${engineers.id}/members/${alan.id}`),
    200,
  );
  await expectJson(context.sendScim("DELETE", `/Groups/${engineering.id}`), 204);
  assertEquals(await readMemberEmails(context, engineers.id), ["alan@example.com"]);
  await expectJson(context.sendScim("GET", `/Groups/${engineering.id}`), 404);
});

defineDirectoryTest("applies a new mapping to the Company group's members at once", async (
  context,
) => {
  const grace = await createScimUser(context, "grace@example.com");
  await createScimGroup(context, "team-research", [grace.id]);
  const researchers = await createMappedGroup(context, "Researchers", ["team-research"]);
  assertEquals(await readMemberEmails(context, researchers.id), ["grace@example.com"]);
  await expectJson(
    context.sendAsAdmin("PUT", `/v1/groups/${researchers.id}/company-groups`, {
      companyGroups: [],
    }),
    200,
  );
  assertEquals(await readMemberEmails(context, researchers.id), []);
});

defineDirectoryTest("keeps a mapping when the directory renames the Company group", async (
  context,
) => {
  const grace = await createScimUser(context, "grace@example.com");
  const engineering = await createScimGroup(context, "team-engineering", [grace.id]);
  const engineers = await createMappedGroup(context, "Engineers", ["team-engineering"]);
  await expectJson(
    context.sendScim("PATCH", `/Groups/${engineering.id}`, {
      Operations: [{ op: "replace", path: "displayName", value: "eng-all" }],
    }),
    200,
  );
  const { groups } = await expectJson<{ groups: Group[] }>(
    context.sendAsAdmin("GET", "/v1/groups"),
    200,
  );
  assertEquals(groups.find((group) => group.id === engineers.id)!.companyGroups, ["eng-all"]);
  assertEquals(await readMemberEmails(context, engineers.id), ["grace@example.com"]);
  // A mapping to the group's ID, as Entra's ID tokens carry it, works as well.
  const byId = await createMappedGroup(context, "By ID", ["5f0e-entra-object-id"]);
  await expectJson(
    context.sendScim("PATCH", `/Groups/${engineering.id}`, {
      Operations: [{ op: "add", path: "externalId", value: "5f0e-entra-object-id" }],
    }),
    200,
  );
  assertEquals(await readMemberEmails(context, byId.id), ["grace@example.com"]);
});

defineDirectoryTest("ends a removed user's access and brings them back when created again", async (
  context,
) => {
  const grace = await createScimUser(context, "grace@example.com");
  const engineers = await createMappedGroup(context, "Engineers", ["team-engineering"]);
  await createScimGroup(context, "team-engineering", [grace.id]);
  assertEquals(await readMemberEmails(context, engineers.id), ["grace@example.com"]);

  await expectJson(
    context.sendScim("PATCH", `/Users/${grace.id}`, {
      Operations: [{ op: "replace", path: "active", value: false }],
    }),
    200,
  );
  assertEquals(await readMemberEmails(context, engineers.id), []);
  await expectJson(
    context.sendScim("PATCH", `/Users/${grace.id}`, {
      Operations: [{ op: "replace", path: "active", value: true }],
    }),
    200,
  );
  assertEquals(await readMemberEmails(context, engineers.id), ["grace@example.com"]);

  await expectJson(context.sendScim("DELETE", `/Users/${grace.id}`), 204);
  await expectJson(context.sendScim("GET", `/Users/${grace.id}`), 404);
  assertEquals(await readMemberEmails(context, engineers.id), []);
  const removedUser = await findUser(context, "grace@example.com");
  assert(removedUser.deactivatedAt !== null, "The record stays, deactivated.");

  const recreated = await createScimUser(context, "grace@example.com");
  assertEquals(recreated.id, grace.id);
  assertEquals(recreated.active, true);
});

defineDirectoryTest("never deactivates the last active Instance admin", async (context) => {
  const grace = await createScimUser(context, "grace@example.com");
  const graceUser = await findUser(context, "grace@example.com");
  await expectJson(
    context.sendAsAdmin("PATCH", `/v1/users/${graceUser.id}`, { isInstanceAdmin: true }),
    200,
  );
  const admin = await findUser(context, ADMIN_EMAIL);
  await expectJson(
    context.sendAsAdmin("PATCH", `/v1/users/${admin.id}`, { isDeactivated: true }),
    200,
  );
  const refused = await expectJson<ScimError>(
    context.sendScim("DELETE", `/Users/${grace.id}`),
    409,
  );
  assertEquals(refused.scimType, "mutability");
});

defineDirectoryTest("imports a CSV file and refuses one with bad rows", async (context) => {
  const engineers = await createMappedGroup(context, "Engineers", ["team-engineering"]);
  const summary = await expectJson<DirectoryImportSummary>(
    send(context.identityService, "POST", "/v1/directory/imports", {
      bearerToken: await signIn(context.identityService, ADMIN_EMAIL, ADMIN_PASSWORD),
      contentType: "text/csv",
      body: "﻿email;displayName;companyGroups;active\n" +
        "grace@example.com;Grace Hopper;team-engineering|all-staff;\n" +
        "alan@example.com;Alan Turing;all-staff;yes\n",
    }),
    200,
  );
  assertEquals(
    [summary.format, summary.rowCount, summary.createdCount, summary.updatedCount],
    ["csv", 2, 2, 0],
  );
  assertEquals(await readMemberEmails(context, engineers.id), ["grace@example.com"]);
  assertEquals((await findUser(context, "alan@example.com")).directorySource, "import");

  const second = await expectJson<DirectoryImportSummary>(
    context.sendAsAdmin("POST", "/v1/directory/imports", {
      users: [
        { email: "grace@example.com", displayName: "Grace Hopper", companyGroups: [] },
        { email: "alan@example.com", displayName: "Alan Turing", active: false },
      ],
    }),
    200,
  );
  assertEquals(
    [second.format, second.updatedCount, second.deactivatedCount, second.unchangedCount],
    ["json", 1, 1, 0],
  );
  assertEquals(await readMemberEmails(context, engineers.id), []);
  assert((await findUser(context, "alan@example.com")).deactivatedAt !== null);

  const csvFailure = await expectJson<DirectoryImportFailure>(
    send(context.identityService, "POST", "/v1/directory/imports", {
      bearerToken: await signIn(context.identityService, ADMIN_EMAIL, ADMIN_PASSWORD),
      contentType: "text/csv",
      body: "email,displayName\nnew@example.com,New Person\nnot-an-email,Someone\n" +
        `${ADMIN_EMAIL},The Admin\n`,
    }),
    400,
  );
  assertEquals(csvFailure.problems.map((problem) => problem.row), [3]);
  const jsonFailure = await expectJson<DirectoryImportFailure>(
    context.sendAsAdmin("POST", "/v1/directory/imports", {
      users: [
        { email: "new@example.com", displayName: "New Person" },
        { email: ADMIN_EMAIL, displayName: "The Admin" },
        { email: "role@example.com", displayName: "Role", role: "admin" },
      ],
    }),
    400,
  );
  assertEquals(jsonFailure.problems.map((problem) => problem.row), [3]);
  const localAccountFailure = await expectJson<DirectoryImportFailure>(
    context.sendAsAdmin("POST", "/v1/directory/imports", {
      users: [
        { email: "new@example.com", displayName: "New Person" },
        { email: ADMIN_EMAIL, displayName: "The Admin" },
      ],
    }),
    400,
  );
  assertEquals(localAccountFailure.problems.map((problem) => problem.row), [2]);
  // Nothing from a refused file is applied.
  assertEquals(await findUser(context, "new@example.com"), undefined);

  const status = await expectJson<DirectoryStatus>(
    context.sendAsAdmin("GET", "/v1/directory"),
    200,
  );
  assertEquals(status.provisionedUserCount, 2);
  assertEquals(status.recentImports.map((recentImport) => recentImport.format), ["json", "csv"]);
  assertEquals(
    status.companyGroups.map((companyGroup) => [
      companyGroup.displayName,
      companyGroup.source,
      companyGroup.memberCount,
      companyGroup.mappedGroups.map((group) => group.name),
    ]),
    [["all-staff", "import", 1, []], ["team-engineering", "import", 0, ["Engineers"]]],
  );
});

defineDirectoryTest("lets the directory take over people from a file and from sign-in", async (
  context,
) => {
  await expectJson(
    context.sendAsAdmin("POST", "/v1/directory/imports", {
      users: [{ email: "grace@example.com", displayName: "Grace", companyGroups: ["team-a"] }],
    }),
    200,
  );
  const grace = await createScimUser(context, "grace@example.com");
  assertEquals((await findUser(context, "grace@example.com")).id, grace.id);
  assertEquals((await findUser(context, "grace@example.com")).directorySource, "scim");
  const teamA = await createScimGroup(context, "team-a", [grace.id]);
  assertEquals((teamA.members as unknown[]).length, 1);
});

defineDirectoryTest("takes an Instance admin for the directory endpoints", async (context) => {
  const grace = await expectJson<User>(
    context.sendAsAdmin("POST", "/v1/users", {
      email: "grace@example.com",
      displayName: "Grace",
      password: "a-user-password",
    }),
    201,
  );
  const graceToken = await signIn(context.identityService, grace.email, "a-user-password");
  for (
    const [method, path, body] of [
      ["GET", "/v1/directory", undefined],
      ["POST", "/v1/directory/tokens", { name: "x" }],
      ["POST", "/v1/directory/imports", { users: [{ email: "a@example.com", displayName: "A" }] }],
    ] as const
  ) {
    const response = await send(context.identityService, method, path, {
      bearerToken: graceToken,
      body,
    });
    assertEquals(response.status, 403, `${method} ${path}`);
    await response.body?.cancel();
  }
});
