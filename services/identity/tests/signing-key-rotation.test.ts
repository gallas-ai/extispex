/** Rotating the key that signs access tokens, and sealing it again with a new master key. */
import { assertEquals } from "@std/assert";
import type { AccessTokenResponse, ListSigningKeysResponse, SigningKey } from "@extispex/contracts";
import { createStructuredLogger, generateMasterKey } from "@extispex/service-runtime";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  createFirstAdministratorIfNone,
  createIdentityService,
  createSigningKeyCipher,
  type IdentityDatabase,
  type IdentityService,
  openIdentityDatabase,
  resealSigningKeys,
} from "../src/create-service.ts";

const ADMIN = { email: "admin@example.com", password: "first-admin-password" };
const USER_PASSWORD = "a-user-password";
const PUBLICATION_SECONDS = 60;

interface RotationContext {
  database: IdentityDatabase;
  createService(masterKeys: string | { current: string; previous: string }): Promise<
    IdentityService
  >;
  advanceClock(seconds: number): void;
}

function defineRotationTest(
  testName: string,
  testBody: (rotationContext: RotationContext) => Promise<void>,
): void {
  for (const testDatabase of listTestDatabases("identity")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openIdentityDatabase(testDatabase.url);
      let clockMilliseconds = Date.parse("2026-11-12T10:00:00Z");
      try {
        for (
          const tableName of [
            "sign_ins",
            "group_members",
            "role_assignments",
            "groups",
            "users",
            "signing_keys",
          ]
        ) {
          await database.orm.em.fork().execute(`delete from ${tableName}`);
        }
        await createFirstAdministratorIfNone(database, ADMIN, { passwordHashIterations: 1_000 });
        await testBody({
          database,
          createService: async (masterKeys) =>
            createIdentityService({
              database,
              signingKeyCipher: await createSigningKeyCipher(masterKeys),
              areLocalAccountsEnabled: true,
              serviceClientSecrets: new Map(),
              logger: createStructuredLogger("identity-test"),
              passwordHashIterations: 1_000,
              signingKeyPublicationSeconds: PUBLICATION_SECONDS,
              readCurrentTime: () => new Date(clockMilliseconds),
            }),
          advanceClock: (seconds) => {
            clockMilliseconds += seconds * 1000;
          },
        });
      } finally {
        await database.close();
      }
    });
  }
}

async function send(
  identityService: IdentityService,
  method: string,
  path: string,
  options: { bearerToken?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.bearerToken) headers.set("authorization", `Bearer ${options.bearerToken}`);
  if (options.cookie) headers.set("cookie", options.cookie);
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

/** Signs in and returns a function that gets a fresh access token with the sign-in cookie. */
async function signIn(identityService: IdentityService, email: string, password: string) {
  const response = await send(identityService, "POST", "/v1/sign-in", {
    body: { email, password },
  });
  assertEquals(response.status, 200, await response.text());
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  return async () =>
    (await expectJson<AccessTokenResponse>(
      send(identityService, "POST", "/v1/sign-in/access-tokens", { cookie, body: {} }),
      200,
    )).accessToken;
}

function readKeyId(accessToken: string): string {
  const header = accessToken.split(".")[0].replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(header)).kid;
}

async function readPublishedKeyIds(identityService: IdentityService): Promise<string[]> {
  const { keys } = await expectJson<{ keys: Array<{ kid: string }> }>(
    send(identityService, "GET", "/internal/v1/jwks.json"),
    200,
  );
  return keys.map((key) => key.kid).sort();
}

defineRotationTest(
  "adds a key, lets it sign after its publication, and removes the old one after the longest token lifetime",
  async ({ createService, advanceClock }) => {
    const identityService = await createService(generateMasterKey());
    const requestAccessToken = await signIn(identityService, ADMIN.email, ADMIN.password);
    const firstToken = await requestAccessToken();
    const firstKeyId = readKeyId(firstToken);
    const listKeys = async (bearerToken: string) =>
      (await expectJson<ListSigningKeysResponse>(
        send(identityService, "GET", "/v1/signing-keys", { bearerToken }),
        200,
      )).keys;
    assertEquals((await listKeys(firstToken)).map((key) => [key.keyId, key.state]), [
      [firstKeyId, "signing"],
    ]);

    advanceClock(1);
    const addedKey = await expectJson<SigningKey>(
      send(identityService, "POST", "/v1/signing-keys", { bearerToken: firstToken }),
      201,
    );
    assertEquals(addedKey.state, "published");
    assertEquals(await readPublishedKeyIds(identityService), [firstKeyId, addedKey.keyId].sort());
    const activationPath = `/v1/signing-keys/${addedKey.keyId}/activation`;
    assertEquals(
      (await expectJson<{ error: { code: string } }>(
        send(identityService, "POST", activationPath, { bearerToken: firstToken }),
        409,
      )).error.code,
      "key_too_new",
    );
    assertEquals(readKeyId(await requestAccessToken()), firstKeyId);

    advanceClock(PUBLICATION_SECONDS);
    const activatedKey = await expectJson<SigningKey>(
      send(identityService, "POST", activationPath, { bearerToken: firstToken }),
      200,
    );
    assertEquals(activatedKey.state, "signing");
    const secondToken = await requestAccessToken();
    assertEquals(readKeyId(secondToken), addedKey.keyId);
    // A token the retired key signed keeps working until it expires.
    const keysAfterActivation = await listKeys(firstToken);
    assertEquals(keysAfterActivation.map((key) => [key.keyId, key.state]), [
      [addedKey.keyId, "signing"],
      [firstKeyId, "retired"],
    ]);
    assertEquals(
      keysAfterActivation[1].removedAt,
      new Date(Date.parse(keysAfterActivation[1].retiredAt!) + 390_000).toISOString(),
    );
    assertEquals(
      (await expectJson<{ error: { code: string } }>(
        send(identityService, "DELETE", `/v1/signing-keys/${addedKey.keyId}`, {
          bearerToken: secondToken,
        }),
        409,
      )).error.code,
      "key_signing",
    );
    assertEquals(
      (await expectJson<{ error: { code: string } }>(
        send(identityService, "POST", `/v1/signing-keys/${firstKeyId}/activation`, {
          bearerToken: secondToken,
        }),
        409,
      )).error.code,
      "key_retired",
    );

    advanceClock(389);
    assertEquals(await readPublishedKeyIds(identityService), [firstKeyId, addedKey.keyId].sort());
    advanceClock(2);
    assertEquals(await readPublishedKeyIds(identityService), [addedKey.keyId]);
    const thirdToken = await requestAccessToken();
    assertEquals((await listKeys(thirdToken)).map((key) => key.keyId), [addedKey.keyId]);
  },
);

defineRotationTest(
  "retires a key that never signed, and takes an Instance admin",
  async ({ createService }) => {
    const identityService = await createService(generateMasterKey());
    const adminToken = await (await signIn(identityService, ADMIN.email, ADMIN.password))();
    const addedKey = await expectJson<SigningKey>(
      send(identityService, "POST", "/v1/signing-keys", { bearerToken: adminToken }),
      201,
    );
    const retiredKey = await expectJson<SigningKey>(
      send(identityService, "DELETE", `/v1/signing-keys/${addedKey.keyId}`, {
        bearerToken: adminToken,
      }),
      200,
    );
    assertEquals(retiredKey.state, "retired");
    await expectJson(
      send(identityService, "POST", "/v1/users", {
        bearerToken: adminToken,
        body: { email: "user@example.com", displayName: "user", password: USER_PASSWORD },
      }),
      201,
    );
    const userToken = await (await signIn(identityService, "user@example.com", USER_PASSWORD))();
    for (
      const [method, path] of [
        ["GET", "/v1/signing-keys"],
        ["POST", "/v1/signing-keys"],
        ["POST", `/v1/signing-keys/${addedKey.keyId}/activation`],
        ["DELETE", `/v1/signing-keys/${addedKey.keyId}`],
      ]
    ) {
      await expectJson(send(identityService, method, path, { bearerToken: userToken }), 403);
    }
  },
);

defineRotationTest(
  "seals the signing keys again with a new master key, which then works alone",
  async ({ database, createService }) => {
    const oldMasterKey = generateMasterKey();
    const newMasterKey = generateMasterKey();
    const before = await createService(oldMasterKey);
    const tokenBefore = await (await signIn(before, ADMIN.email, ADMIN.password))();

    const rotatingCipher = await createSigningKeyCipher({
      current: newMasterKey,
      previous: oldMasterKey,
    });
    assertEquals(await resealSigningKeys(database, rotatingCipher), {
      resealedCount: 1,
      currentCount: 0,
    });
    assertEquals(await resealSigningKeys(database, rotatingCipher), {
      resealedCount: 0,
      currentCount: 1,
    });

    const after = await createService(newMasterKey);
    const tokenAfter = await (await signIn(after, ADMIN.email, ADMIN.password))();
    assertEquals(readKeyId(tokenAfter), readKeyId(tokenBefore));
    await expectJson(send(after, "GET", "/v1/signing-keys", { bearerToken: tokenBefore }), 200);
  },
);
