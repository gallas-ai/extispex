import { assertEquals, assertRejects } from "@std/assert";
import { IdentityUnavailableError } from "../src/identity-unavailable-error.ts";
import {
  createIdentityServiceTokenSource,
  createServiceTokenClient,
  UnknownProjectError,
} from "../src/service-tokens.ts";

interface TokenRequest {
  authorization: string | null;
  projectId: string | undefined;
}

function createFakeIdentity(readNow: () => number) {
  const tokenRequests: TokenRequest[] = [];
  return {
    tokenRequests,
    client: async (request: Request) => {
      const { projectId } = await request.json();
      tokenRequests.push({ authorization: request.headers.get("authorization"), projectId });
      if (projectId === "deleted-project") return new Response(null, { status: 404 });
      return Response.json({
        accessToken: `token-${tokenRequests.length}`,
        expiresAt: new Date(readNow() + 300_000).toISOString(),
        projectId: projectId ?? null,
        role: projectId === undefined ? null : "viewer",
      });
    },
  };
}

Deno.test("keeps a service token until a minute before it expires", async () => {
  let currentMilliseconds = Date.parse("2026-11-08T10:00:00Z");
  const fakeIdentity = createFakeIdentity(() => currentMilliseconds);
  const serviceTokens = createIdentityServiceTokenSource({
    identityClient: fakeIdentity.client,
    clientId: "evaluation",
    clientSecret: "evaluation-secret",
    readCurrentTime: () => new Date(currentMilliseconds),
  });

  assertEquals(await serviceTokens.readServiceToken("project-one"), "token-1");
  assertEquals(await serviceTokens.readServiceToken(null), "token-2");
  currentMilliseconds += 239_999;
  assertEquals(await serviceTokens.readServiceToken("project-one"), "token-1");
  currentMilliseconds += 1;
  assertEquals(await serviceTokens.readServiceToken("project-one"), "token-3");
  assertEquals(fakeIdentity.tokenRequests[0], {
    authorization: `Basic ${btoa("evaluation:evaluation-secret")}`,
    projectId: "project-one",
  });
  assertEquals(fakeIdentity.tokenRequests[1].projectId, undefined);
  await assertRejects(
    () => serviceTokens.readServiceToken("deleted-project"),
    UnknownProjectError,
  );
});

Deno.test("explains refused client credentials", async () => {
  const serviceTokens = createIdentityServiceTokenSource({
    identityClient: () => Promise.resolve(new Response(null, { status: 401 })),
    clientId: "telemetry",
    clientSecret: "wrong",
  });
  await assertRejects(
    () => serviceTokens.readServiceToken(null),
    IdentityUnavailableError,
    "IDENTITY_CLIENT_SECRET",
  );
});

Deno.test("sends the service token and replaces a refused one once", async () => {
  const fakeIdentity = createFakeIdentity(() => Date.now());
  const serviceTokens = createIdentityServiceTokenSource({
    identityClient: fakeIdentity.client,
    clientId: "telemetry",
    clientSecret: "telemetry-secret",
  });
  const receivedAuthorizations: (string | null)[] = [];
  const serviceClient = createServiceTokenClient(async (request) => {
    receivedAuthorizations.push(request.headers.get("authorization"));
    assertEquals(await request.json(), { apiKey: "extispex_key" });
    return new Response(null, { status: receivedAuthorizations.length === 1 ? 401 : 200 });
  }, serviceTokens);

  const response = await serviceClient(
    new Request("http://identity/internal/v1/api-keys/resolve", {
      method: "POST",
      body: JSON.stringify({ apiKey: "extispex_key" }),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(receivedAuthorizations, ["Bearer token-1", "Bearer token-2"]);
});
