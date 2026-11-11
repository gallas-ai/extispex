/**
 * Sign-in through the company's identity provider, against a fake provider that signs real ID
 * tokens and checks PKCE, as `tests/e2e/oidc-sign-in.test.ts` does against Keycloak.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessTokenResponse, Group, Project, SignInOptions, User } from "@extispex/contracts";
import { createStructuredLogger } from "@extispex/service-runtime";
import { listTestDatabases } from "@extispex/service-storage/testing";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createFirstAdministratorIfNone,
  createIdentityService,
  type IdentityDatabase,
  type IdentityService,
  type OidcSettings,
  openIdentityDatabase,
  readOidcSettings,
} from "../src/create-service.ts";

const ISSUER = "https://idp.example.test";
const CLIENT_ID = "extispex";
const CLIENT_SECRET = "oidcClientSecret";
const REDIRECT_URL = "https://extispex.example.test/v1/sign-in/oidc/callback";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const PASSWORD_HASH_ITERATIONS = 1_000;

const OIDC_SETTINGS: OidcSettings = {
  issuerUrl: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUrl: REDIRECT_URL,
  scopes: "openid profile email",
  groupsClaim: "groups",
  providerName: "Example SSO",
  allowsInsecureHttp: false,
};

interface PersonAtProvider {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
}

interface IssuedCode {
  person: PersonAtProvider;
  nonce: string;
  codeChallenge: string;
}

interface FakeProvider {
  fetch: typeof fetch;
  issueCode(code: string, issuedCode: IssuedCode): void;
  /** Whether the provider answers at all. */
  setAvailable(isAvailable: boolean): void;
  /** Makes the next ID token carry this nonce instead of the one the client sent. */
  replaceNextNonce(nonce: string): void;
}

async function createFakeProvider(): Promise<FakeProvider> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  const keyId = await calculateJwkThumbprint(publicJwk);
  const issuedCodes = new Map<string, IssuedCode>();
  let isAvailable = true;
  let replacementNonce: string | null = null;

  const answerTokenRequest = async (init: RequestInit | undefined) => {
    const form = new URLSearchParams(String(init?.body));
    const authorization = new Headers(init?.headers).get("authorization");
    assertEquals(authorization, `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    assertEquals(form.get("redirect_uri"), REDIRECT_URL);
    const issuedCode = issuedCodes.get(form.get("code") ?? "");
    if (issuedCode === undefined) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    issuedCodes.delete(form.get("code")!);
    const challenge = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(form.get("code_verifier") ?? ""),
      ),
    );
    const expectedChallenge = btoa(String.fromCharCode(...challenge))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    if (expectedChallenge !== issuedCode.codeChallenge) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const idToken = await new SignJWT({
      ...issuedCode.person,
      nonce: replacementNonce ?? issuedCode.nonce,
    })
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    replacementNonce = null;
    return Response.json({ access_token: "opaque", token_type: "Bearer", id_token: idToken });
  };

  const fetchFromProvider = (input: unknown, init?: RequestInit): Promise<Response> => {
    if (!isAvailable) return Promise.reject(new TypeError("connection refused"));
    const { pathname } = new URL(String(input));
    switch (pathname) {
      case "/.well-known/openid-configuration":
        return Promise.resolve(Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
        }));
      case "/jwks":
        return Promise.resolve(
          new Response(
            JSON.stringify({ keys: [{ ...publicJwk, kid: keyId, use: "sig", alg: "ES256" }] }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      case "/token":
        return answerTokenRequest(init);
      default:
        return Promise.resolve(new Response(null, { status: 404 }));
    }
  };

  return {
    fetch: fetchFromProvider as typeof fetch,
    issueCode: (code, issuedCode) => issuedCodes.set(code, issuedCode),
    setAvailable: (available) => isAvailable = available,
    replaceNextNonce: (nonce) => replacementNonce = nonce,
  };
}

interface OidcTestContext {
  identityService: IdentityService;
  provider: FakeProvider;
  /** An access token of the first administrator, without a Project. */
  adminToken: string;
  database: IdentityDatabase;
}

function defineOidcTest(testName: string, testBody: (context: OidcTestContext) => Promise<void>) {
  for (const testDatabase of listTestDatabases("identity")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openIdentityDatabase(testDatabase.url);
      try {
        for (
          const tableName of [
            "company_group_members",
            "company_groups",
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
          ]
        ) {
          await database.orm.em.fork().execute(`delete from ${tableName}`);
        }
        await createFirstAdministratorIfNone(
          database,
          { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
          { passwordHashIterations: PASSWORD_HASH_ITERATIONS },
        );
        const provider = await createFakeProvider();
        const identityService = createIdentityService({
          database,
          areLocalAccountsEnabled: true,
          serviceClientSecrets: new Map(),
          oidcSettings: OIDC_SETTINGS,
          fetchFromOidcProvider: provider.fetch,
          logger: createStructuredLogger("identity-test"),
          passwordHashIterations: PASSWORD_HASH_ITERATIONS,
        });
        const signInResponse = await send(identityService, "POST", "/v1/sign-in", {
          body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        });
        assertEquals(signInResponse.status, 200);
        await signInResponse.body?.cancel();
        const { accessToken } = await readAccessToken(
          identityService,
          signInResponse.headers.get("set-cookie")!.split(";")[0],
        );
        await testBody({ identityService, provider, adminToken: accessToken, database });
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
  options: { body?: unknown; bearerToken?: string; cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.bearerToken !== undefined) {
    headers.set("authorization", `Bearer ${options.bearerToken}`);
  }
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return Promise.resolve(identityService.handleRequest(
    new Request(`http://identity.test${path}`, {
      method,
      headers,
      redirect: "manual",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  ));
}

async function readAccessToken(
  identityService: IdentityService,
  cookie: string,
  projectId?: string,
): Promise<AccessTokenResponse> {
  const response = await send(identityService, "POST", "/v1/sign-in/access-tokens", {
    cookie,
    body: projectId === undefined ? {} : { projectId },
  });
  assertEquals(response.status, 200);
  return await response.json();
}

interface ProviderRedirect {
  state: string;
  nonce: string;
  codeChallenge: string;
  attemptCookie: string;
  authorizationUrl: URL;
}

async function startSignIn(
  identityService: IdentityService,
  returnTo?: string,
): Promise<ProviderRedirect> {
  const query = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  const response = await send(identityService, "GET", `/v1/sign-in/oidc/authorize${query}`);
  assertEquals(response.status, 302);
  const authorizationUrl = new URL(response.headers.get("location")!);
  return {
    state: authorizationUrl.searchParams.get("state")!,
    nonce: authorizationUrl.searchParams.get("nonce")!,
    codeChallenge: authorizationUrl.searchParams.get("code_challenge")!,
    attemptCookie: response.headers.get("set-cookie")!.split(";")[0],
    authorizationUrl,
  };
}

function callBack(
  identityService: IdentityService,
  redirect: ProviderRedirect,
  code: string,
  options: { state?: string; cookie?: string | null } = {},
): Promise<Response> {
  const query = new URLSearchParams({ code, state: options.state ?? redirect.state });
  return send(identityService, "GET", `/v1/sign-in/oidc/callback?${query}`, {
    cookie: options.cookie === null ? undefined : options.cookie ?? redirect.attemptCookie,
  });
}

/** Goes through the whole flow as this person and resolves to the callback's response. */
async function signInAs(
  { identityService, provider }: OidcTestContext,
  person: PersonAtProvider,
  returnTo?: string,
): Promise<Response> {
  const redirect = await startSignIn(identityService, returnTo);
  provider.issueCode("the-code", {
    person,
    nonce: redirect.nonce,
    codeChallenge: redirect.codeChallenge,
  });
  return await callBack(identityService, redirect, "the-code");
}

function readSignInCookie(response: Response): string {
  const signInCookie = response.headers.getSetCookie().find((cookie) =>
    cookie.startsWith("extispex_sign_in=")
  );
  assert(signInCookie !== undefined, "The response set no sign-in cookie.");
  return signInCookie.split(";")[0];
}

function assertFailure(response: Response, failure: string) {
  assertEquals(response.status, 302);
  assertEquals(response.headers.get("location"), `/?signInError=${failure}`);
  assertEquals(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("extispex_sign_in=")),
    false,
  );
}

async function createGroupWithCompanyGroup(
  { identityService, adminToken }: OidcTestContext,
  name: string,
  companyGroup: string,
): Promise<Group> {
  const groupResponse = await send(identityService, "POST", "/v1/groups", {
    bearerToken: adminToken,
    body: { name },
  });
  assertEquals(groupResponse.status, 201);
  const group: Group = await groupResponse.json();
  const mappingResponse = await send(
    identityService,
    "PUT",
    `/v1/groups/${group.id}/company-groups`,
    { bearerToken: adminToken, body: { companyGroups: [companyGroup] } },
  );
  assertEquals(mappingResponse.status, 200);
  await mappingResponse.body?.cancel();
  return group;
}

async function readGroupMembers(context: OidcTestContext, groupId: string) {
  const response = await send(context.identityService, "GET", "/v1/groups", {
    bearerToken: context.adminToken,
  });
  const { groups }: { groups: Group[] } = await response.json();
  return groups.find((group) => group.id === groupId)!.members;
}

const ADA: PersonAtProvider = {
  sub: "subject-ada",
  email: "Ada@Example.com",
  email_verified: true,
  name: "Ada Lovelace",
  groups: ["team-engineering"],
};

defineOidcTest("offers the provider on the sign-in page", async ({ identityService }) => {
  const response = await send(identityService, "GET", "/v1/sign-in/options");
  assertEquals(await response.json() as SignInOptions, {
    areLocalAccountsEnabled: true,
    oidcProviderName: "Example SSO",
  });
});

defineOidcTest("sends the browser to the provider with PKCE", async ({ identityService }) => {
  const { authorizationUrl, attemptCookie } = await startSignIn(identityService);
  assertEquals(authorizationUrl.origin + authorizationUrl.pathname, `${ISSUER}/authorize`);
  assertEquals(authorizationUrl.searchParams.get("client_id"), CLIENT_ID);
  assertEquals(authorizationUrl.searchParams.get("redirect_uri"), REDIRECT_URL);
  assertEquals(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assertEquals(authorizationUrl.searchParams.get("scope"), "openid profile email");
  assertStringIncludes(attemptCookie, "extispex_oidc_attempt=");
});

defineOidcTest("creates the user on first sign-in, with the Roles of their Groups", async (
  context,
) => {
  const { identityService, adminToken } = context;
  const projectResponse = await send(identityService, "POST", "/v1/projects", {
    bearerToken: adminToken,
    body: { name: "Engineering" },
  });
  const project: Project = await projectResponse.json();
  const group = await createGroupWithCompanyGroup(context, "Engineers", "team-engineering");
  const assignment = await send(
    identityService,
    "PUT",
    `/v1/projects/${project.id}/role-assignments/${group.id}`,
    { bearerToken: adminToken, body: { role: "editor" } },
  );
  await assignment.body?.cancel();

  const callback = await signInAs(context, ADA, "/traces?sessionId=42");

  assertEquals(callback.status, 302);
  assertEquals(callback.headers.get("location"), "/traces?sessionId=42");
  const cookie = readSignInCookie(callback);
  assertEquals((await readAccessToken(identityService, cookie, project.id)).role, "editor");
  const { accessToken } = await readAccessToken(identityService, cookie);
  const user: User = await (await send(identityService, "GET", "/v1/me", {
    bearerToken: accessToken,
  })).json();
  assertEquals(
    [user.email, user.displayName, user.isLocalAccount, user.isInstanceAdmin],
    ["ada@example.com", "Ada Lovelace", false, false],
  );
  assertEquals(
    (await readGroupMembers(context, group.id)).map((member) => member.isFromCompanyGroup),
    [true],
  );
});

defineOidcTest("signs the same person in again as the same user, with a new email", async (
  context,
) => {
  const { identityService } = context;
  const firstCookie = readSignInCookie(await signInAs(context, ADA));
  const firstToken = await readAccessToken(identityService, firstCookie);
  const secondCookie = readSignInCookie(
    await signInAs(context, { ...ADA, email: "ada.byron@example.com", name: "Ada Byron" }),
  );
  const secondToken = await readAccessToken(identityService, secondCookie);
  const readMe = async (accessToken: string) =>
    await (await send(identityService, "GET", "/v1/me", { bearerToken: accessToken }))
      .json() as User;
  const firstUser = await readMe(firstToken.accessToken);
  const secondUser = await readMe(secondToken.accessToken);
  assertEquals(firstUser.id, secondUser.id);
  assertEquals([secondUser.email, secondUser.displayName], ["ada.byron@example.com", "Ada Byron"]);
});

defineOidcTest("follows the Company groups, and leaves members added by hand", async (context) => {
  const { identityService, adminToken } = context;
  const engineers = await createGroupWithCompanyGroup(context, "Engineers", "team-engineering");
  const reviewers = await createGroupWithCompanyGroup(context, "Reviewers", "team-reviewers");
  const cookie = readSignInCookie(
    await signInAs(context, { ...ADA, groups: ["team-engineering", "team-reviewers", "unmapped"] }),
  );
  const { accessToken } = await readAccessToken(identityService, cookie);
  const user: User = await (await send(identityService, "GET", "/v1/me", {
    bearerToken: accessToken,
  })).json();
  assertEquals((await readGroupMembers(context, engineers.id)).length, 1);
  assertEquals((await readGroupMembers(context, reviewers.id)).length, 1);

  // An admin adds the user by hand to a third Group, which has no Company group.
  const handPicked = await (await send(identityService, "POST", "/v1/groups", {
    bearerToken: adminToken,
    body: { name: "Hand-picked" },
  })).json() as Group;
  const addition = await send(
    identityService,
    "PUT",
    `/v1/groups/${handPicked.id}/members/${user.id}`,
    { bearerToken: adminToken },
  );
  await addition.body?.cancel();

  await (await signInAs(context, { ...ADA, groups: ["team-engineering"] })).body?.cancel();

  assertEquals((await readGroupMembers(context, engineers.id)).length, 1);
  assertEquals((await readGroupMembers(context, reviewers.id)).length, 0);
  assertEquals((await readGroupMembers(context, handPicked.id)).length, 1);

  // A token without the groups claim means no Company groups.
  await (await signInAs(context, { ...ADA, groups: undefined })).body?.cancel();
  assertEquals((await readGroupMembers(context, engineers.id)).length, 0);
  assertEquals((await readGroupMembers(context, handPicked.id)).length, 1);
});

defineOidcTest("never matches an existing user by email", async (context) => {
  const callback = await signInAs(context, {
    sub: "attacker",
    email: ADMIN_EMAIL,
    name: "Mallory",
  });
  assertFailure(callback, "email_taken");
});

defineOidcTest("keeps a changed email that another user already holds", async (context) => {
  const { identityService } = context;
  await (await signInAs(context, { ...ADA, sub: "subject-other", email: "taken@example.com" }))
    .body?.cancel();
  const cookie = readSignInCookie(await signInAs(context, ADA));
  const callback = await signInAs(context, { ...ADA, email: "taken@example.com" });
  await callback.body?.cancel();
  const { accessToken } = await readAccessToken(identityService, cookie);
  const user: User = await (await send(identityService, "GET", "/v1/me", {
    bearerToken: accessToken,
  })).json();
  assertEquals(user.email, "ada@example.com");
});

defineOidcTest("refuses a token without a verified email", async (context) => {
  assertFailure(await signInAs(context, { ...ADA, email: undefined }), "email_missing");
  assertFailure(await signInAs(context, { ...ADA, email: "not an email" }), "email_missing");
  assertFailure(await signInAs(context, { ...ADA, email_verified: false }), "email_missing");
});

defineOidcTest("refuses a deactivated user", async (context) => {
  const { identityService, adminToken } = context;
  const cookie = readSignInCookie(await signInAs(context, ADA));
  const { accessToken } = await readAccessToken(identityService, cookie);
  const user: User = await (await send(identityService, "GET", "/v1/me", {
    bearerToken: accessToken,
  })).json();
  const deactivation = await send(identityService, "PATCH", `/v1/users/${user.id}`, {
    bearerToken: adminToken,
    body: { isDeactivated: true },
  });
  await deactivation.body?.cancel();
  assertFailure(await signInAs(context, ADA), "user_deactivated");
});

defineOidcTest("gives a user from the provider no password to change", async (context) => {
  const cookie = readSignInCookie(await signInAs(context, ADA));
  const response = await send(context.identityService, "PUT", "/v1/sign-in/password", {
    cookie,
    body: { currentPassword: "whatever", newPassword: "a-new-long-password" },
  });
  assertEquals(response.status, 403);
  assertEquals((await response.json()).error.code, "not_a_local_account");
});

defineOidcTest("ties a sign-in to its browser and its state, once", async (context) => {
  const { identityService, provider } = context;
  const issueCodeFor = (redirect: ProviderRedirect, code: string) =>
    provider.issueCode(code, {
      person: ADA,
      nonce: redirect.nonce,
      codeChallenge: redirect.codeChallenge,
    });

  const withoutCookie = await startSignIn(identityService);
  issueCodeFor(withoutCookie, "code-1");
  assertFailure(
    await callBack(identityService, withoutCookie, "code-1", { cookie: null }),
    "attempt_expired",
  );

  const withOtherCookie = await startSignIn(identityService);
  issueCodeFor(withOtherCookie, "code-2");
  assertFailure(
    await callBack(identityService, withOtherCookie, "code-2", {
      cookie: "extispex_oidc_attempt=another-browser",
    }),
    "attempt_expired",
  );

  const withOtherState = await startSignIn(identityService);
  issueCodeFor(withOtherState, "code-3");
  assertFailure(
    await callBack(identityService, withOtherState, "code-3", { state: "forged" }),
    "attempt_expired",
  );

  const replayed = await startSignIn(identityService);
  issueCodeFor(replayed, "code-4");
  const firstCallback = await callBack(identityService, replayed, "code-4");
  assertEquals(firstCallback.status, 302);
  await firstCallback.body?.cancel();
  issueCodeFor(replayed, "code-5");
  assertFailure(await callBack(identityService, replayed, "code-5"), "attempt_expired");
});

defineOidcTest("refuses an ID token that answers another request", async (context) => {
  context.provider.replaceNextNonce("the-nonce-of-another-sign-in");
  assertFailure(await signInAs(context, ADA), "provider_refused");
});

defineOidcTest("refuses a code the provider rejects", async ({ identityService }) => {
  const redirect = await startSignIn(identityService);
  assertFailure(await callBack(identityService, redirect, "never-issued"), "provider_refused");
});

defineOidcTest("reports an identity provider that cannot be reached", async (context) => {
  context.provider.setAvailable(false);
  const response = await send(context.identityService, "GET", "/v1/sign-in/oidc/authorize");
  assertFailure(response, "provider_unavailable");
  // Reading the provider's configuration is tried again, so that recovery needs no restart.
  context.provider.setAvailable(true);
  await startSignIn(context.identityService);
});

for (
  const unsafeReturnPath of [
    "https://evil.example.test/",
    "//evil.example.test/",
    "/\\evil.example.test/",
    "traces",
  ]
) {
  defineOidcTest(`returns to the start page instead of ${unsafeReturnPath}`, async (context) => {
    const callback = await signInAs(context, ADA, unsafeReturnPath);
    assertEquals(callback.headers.get("location"), "/");
    await callback.body?.cancel();
  });
}

Deno.test("reads no OIDC settings without an issuer", () => {
  assertEquals(readOidcSettings(() => undefined), null);
});

Deno.test("needs every OIDC setting, and TLS unless told otherwise", () => {
  const variables: Record<string, string> = {
    OIDC_ISSUER_URL: "https://idp.example.test",
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_REDIRECT_URL: REDIRECT_URL,
  };
  const read = (overrides: Record<string, string | undefined>) =>
    readOidcSettings((name) => ({ ...variables, ...overrides })[name]);
  assertEquals(read({})?.groupsClaim, "groups");
  assertEquals(read({ OIDC_GROUPS_CLAIM: "roles" })?.groupsClaim, "roles");
  const expectRefused = (overrides: Record<string, string | undefined>) => {
    try {
      read(overrides);
    } catch {
      return;
    }
    throw new Error(`Expected ${JSON.stringify(overrides)} to be refused.`);
  };
  expectRefused({ OIDC_CLIENT_ID: undefined });
  expectRefused({ OIDC_CLIENT_SECRET: undefined });
  expectRefused({ OIDC_REDIRECT_URL: undefined });
  expectRefused({ OIDC_ISSUER_URL: "http://idp.example.test" });
  assertEquals(
    read({ OIDC_ISSUER_URL: "http://localhost:8180", OIDC_ALLOW_INSECURE_HTTP: "enabled" })
      ?.allowsInsecureHttp,
    true,
  );
});

/** Imports one person, as a company without SCIM would, and maps their Company group. */
async function importPerson(
  context: OidcTestContext,
  person: { email: string; companyGroups: string[]; active?: boolean },
) {
  const response = await send(context.identityService, "POST", "/v1/directory/imports", {
    bearerToken: context.adminToken,
    body: { users: [{ displayName: "Imported Person", ...person }] },
  });
  assertEquals(response.status, 200, await response.clone().text());
  await response.body?.cancel();
}

async function listUsers(context: OidcTestContext): Promise<User[]> {
  const response = await send(context.identityService, "GET", "/v1/users", {
    bearerToken: context.adminToken,
  });
  return (await response.json() as { users: User[] }).users;
}

defineOidcTest("links the first sign-in to a user from the directory, once", async (context) => {
  await importPerson(context, { email: "grace@example.com", companyGroups: ["team-research"] });
  const researchers = await createGroupWithCompanyGroup(context, "Researchers", "team-research");
  const [importedUser] = (await listUsers(context)).filter((user) =>
    user.email === "grace@example.com"
  );

  const signIn = await signInAs(context, {
    sub: "grace-at-provider",
    email: "grace@example.com",
    email_verified: true,
    name: "Grace Hopper",
    groups: [],
  });
  assertEquals(signIn.status, 302);
  readSignInCookie(signIn);
  const usersAfter = (await listUsers(context)).filter((user) =>
    user.email === "grace@example.com"
  );
  assertEquals(usersAfter.map((user) => user.id), [importedUser.id]);
  // A token without groups keeps what the directory says.
  assertEquals(
    (await readGroupMembers(context, researchers.id)).map((member) => member.email),
    ["grace@example.com"],
  );

  // Linked once: another subject with the same email is someone else.
  assertFailure(
    await signInAs(context, {
      sub: "someone-else",
      email: "grace@example.com",
      email_verified: true,
    }),
    "email_taken",
  );
  assertEquals(
    (await signInAs(context, { sub: "grace-at-provider", email: "grace@example.com" }))
      .status,
    302,
  );
});

defineOidcTest("refuses to link a deactivated user from the directory", async (context) => {
  await importPerson(context, { email: "alan@example.com", companyGroups: [], active: false });
  assertFailure(
    await signInAs(context, { sub: "alan", email: "alan@example.com", email_verified: true }),
    "user_deactivated",
  );
});

defineOidcTest("refuses to link a user from the directory with an unverified email", async (
  context,
) => {
  await importPerson(context, { email: "eve@example.com", companyGroups: [] });
  assertFailure(
    await signInAs(context, { sub: "eve", email: "eve@example.com", email_verified: false }),
    "email_missing",
  );
});
