import { assertEquals, assertRejects } from "@std/assert";
import { createAccessTokenVerifier, signAccessToken } from "../src/access-tokens.ts";
import { IdentityUnavailableError } from "../src/identity-unavailable-error.ts";
import type { ProjectResolver } from "../src/project-authentication.ts";
import { createRequestAuthenticator } from "../src/request-authentication.ts";
import { createTestAccessTokens } from "../src/testing.ts";

const testProjectResolver: ProjectResolver = {
  resolveProjectId: (apiKey) =>
    Promise.resolve(apiKey === "extispex_working" ? "project-one" : null),
};

Deno.test("gives an API key the Role editor in its Project", async () => {
  const testTokens = await createTestAccessTokens();
  const requestAuthenticator = createRequestAuthenticator({
    projectResolver: testProjectResolver,
    accessTokenVerifier: testTokens.accessTokenVerifier,
  });
  assertEquals(await requestAuthenticator.authenticateRequest("Bearer extispex_working"), {
    projectId: "project-one",
    role: "editor",
  });
  assertEquals(await requestAuthenticator.authenticateRequest("bearer extispex_working"), {
    projectId: "project-one",
    role: "editor",
  });
  assertEquals(await requestAuthenticator.authenticateRequest("Bearer extispex_unknown"), null);
  assertEquals(await requestAuthenticator.authenticateRequest("Basic extispex_working"), null);
  assertEquals(await requestAuthenticator.authenticateRequest(undefined), null);
});

Deno.test("takes the Project and Role from a valid access token", async () => {
  const testTokens = await createTestAccessTokens();
  const otherIssuer = await createTestAccessTokens();
  const requestAuthenticator = createRequestAuthenticator({
    projectResolver: { resolveProjectId: () => Promise.reject(new Error("Not an API key.")) },
    accessTokenVerifier: testTokens.accessTokenVerifier,
  });
  const authenticate = async (accessToken: string) =>
    await requestAuthenticator.authenticateRequest(`Bearer ${accessToken}`);

  assertEquals(
    await authenticate(
      await testTokens.issueAccessToken({ projectId: "project-one", role: "viewer" }),
    ),
    { projectId: "project-one", role: "viewer" },
  );
  // A token without a Project manages access only; it reaches no Project's data.
  assertEquals(await authenticate(await testTokens.issueAccessToken({})), null);
  assertEquals(
    await authenticate(
      await testTokens.issueAccessToken({
        projectId: "project-one",
        role: "admin",
        expiresInSeconds: -10,
      }),
    ),
    null,
  );
  assertEquals(
    await authenticate(
      await otherIssuer.issueAccessToken({ projectId: "project-one", role: "admin" }),
    ),
    null,
  );
  assertEquals(await authenticate("not.a.token"), null);
});

Deno.test("reads Identity's keys again for a token with a new key ID", async () => {
  const createKey = async (keyId: string) => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    return {
      signingKey: { keyId, privateKey: keyPair.privateKey },
      publicKey: { ...await crypto.subtle.exportKey("jwk", keyPair.publicKey), kid: keyId },
    };
  };
  const firstKey = await createKey("first");
  const secondKey = await createKey("second");
  let publishedKeys = [firstKey.publicKey];
  let readCount = 0;
  let currentMilliseconds = Date.now();
  const verifier = createAccessTokenVerifier({
    readPublicKeySet: () => {
      readCount++;
      return Promise.resolve({ keys: publishedKeys });
    },
    readCurrentTime: () => new Date(currentMilliseconds),
  });
  const signWith = (signingKey: typeof firstKey.signingKey) =>
    signAccessToken(signingKey, {
      subject: "user:one",
      projectAccess: { projectId: "project-one", role: "editor" },
      issuedAt: new Date(currentMilliseconds),
      expiresAt: new Date(currentMilliseconds + 300_000),
    });

  assertEquals(
    (await verifier.verifyAccessToken(await signWith(firstKey.signingKey)))?.role,
    "editor",
  );
  publishedKeys = [firstKey.publicKey, secondKey.publicKey];
  // Right after a read, an unknown key ID does not make it read again.
  assertEquals(await verifier.verifyAccessToken(await signWith(secondKey.signingKey)), null);
  assertEquals(readCount, 1);
  currentMilliseconds += 30_000;
  assertEquals(
    (await verifier.verifyAccessToken(await signWith(secondKey.signingKey)))?.subject,
    "user:one",
  );
  assertEquals(readCount, 2);
});

Deno.test("reports that the keys cannot be read", async () => {
  const verifier = createAccessTokenVerifier({
    readPublicKeySet: () => Promise.reject(new IdentityUnavailableError("down")),
  });
  const testTokens = await createTestAccessTokens();
  await assertRejects(
    async () =>
      await verifier.verifyAccessToken(
        await testTokens.issueAccessToken({ projectId: "project-one", role: "viewer" }),
      ),
    IdentityUnavailableError,
  );
});
