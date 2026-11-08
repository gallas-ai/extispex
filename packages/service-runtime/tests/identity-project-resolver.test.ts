import { assertEquals, assertRejects } from "@std/assert";
import type { ServiceClient } from "@extispex/service-client";
import { IdentityUnavailableError } from "../src/identity-unavailable-error.ts";
import { createIdentityProjectResolver } from "../src/project-authentication.ts";

/** Stands in for Identity: knows a fixed set of keys and counts the calls it receives. */
interface FakeIdentity {
  callCount: number;
  projectIdsByApiKey: Record<string, string>;
  client: ServiceClient;
}

function createFakeIdentity(projectIdsByApiKey: Record<string, string>): FakeIdentity {
  const fakeIdentity: FakeIdentity = {
    callCount: 0,
    projectIdsByApiKey,
    client: async (request) => {
      fakeIdentity.callCount++;
      assertEquals(new URL(request.url).pathname, "/internal/v1/api-keys/resolve");
      const { apiKey } = await request.json();
      const projectId: string | undefined = fakeIdentity.projectIdsByApiKey[apiKey];
      return projectId === undefined
        ? Response.json({ error: { code: "not_found", message: "" } }, { status: 404 })
        : Response.json({ projectId });
    },
  };
  return fakeIdentity;
}

function createClock() {
  const clock = {
    currentMilliseconds: Date.parse("2026-11-07T10:00:00Z"),
    readCurrentTime: () => new Date(clock.currentMilliseconds),
  };
  return clock;
}

Deno.test("reuses Identity's answer for a minute, then asks again", async () => {
  const fakeIdentity = createFakeIdentity({ "working-key": "project-one" });
  const clock = createClock();
  const projectResolver = createIdentityProjectResolver({
    identityClient: fakeIdentity.client,
    readCurrentTime: clock.readCurrentTime,
  });

  assertEquals(await projectResolver.resolveProjectId("working-key"), "project-one");
  assertEquals(await projectResolver.resolveProjectId("unknown-key"), null);
  // The key is revoked now, but the cached answers stand until they expire.
  delete fakeIdentity.projectIdsByApiKey["working-key"];
  clock.currentMilliseconds += 59_999;
  assertEquals(await projectResolver.resolveProjectId("working-key"), "project-one");
  assertEquals(await projectResolver.resolveProjectId("unknown-key"), null);
  assertEquals(fakeIdentity.callCount, 2);

  clock.currentMilliseconds += 1;
  assertEquals(await projectResolver.resolveProjectId("working-key"), null);
  assertEquals(fakeIdentity.callCount, 3);
});

Deno.test("asks Identity once for concurrent requests with the same key", async () => {
  const fakeIdentity = createFakeIdentity({ "working-key": "project-one" });
  const projectResolver = createIdentityProjectResolver({ identityClient: fakeIdentity.client });

  const projectIds = await Promise.all(
    Array.from({ length: 10 }, () => projectResolver.resolveProjectId("working-key")),
  );

  assertEquals(projectIds, Array(10).fill("project-one"));
  assertEquals(fakeIdentity.callCount, 1);
});

Deno.test("forgets the least recently used keys beyond its limit", async () => {
  const fakeIdentity = createFakeIdentity({ first: "project-one", second: "project-two" });
  const projectResolver = createIdentityProjectResolver({
    identityClient: fakeIdentity.client,
    maximumCachedApiKeys: 2,
  });

  await projectResolver.resolveProjectId("first");
  await projectResolver.resolveProjectId("second");
  await projectResolver.resolveProjectId("first");
  await projectResolver.resolveProjectId("third");
  assertEquals(fakeIdentity.callCount, 3);

  await projectResolver.resolveProjectId("first");
  assertEquals(fakeIdentity.callCount, 3, "first was used recently and stays cached");
  await projectResolver.resolveProjectId("second");
  assertEquals(fakeIdentity.callCount, 4, "second was the least recently used and was dropped");
});

Deno.test("refuses overlong keys without asking Identity", async () => {
  const fakeIdentity = createFakeIdentity({});
  const projectResolver = createIdentityProjectResolver({ identityClient: fakeIdentity.client });
  assertEquals(await projectResolver.resolveProjectId("x".repeat(257)), null);
  assertEquals(fakeIdentity.callCount, 0);
});

Deno.test("reports an unavailable Identity without caching it", async () => {
  let identityAnswer: () => Promise<Response> = () =>
    Promise.reject(new TypeError("connection refused"));
  const projectResolver = createIdentityProjectResolver({
    identityClient: () => identityAnswer(),
  });

  await assertRejects(
    () => projectResolver.resolveProjectId("working-key"),
    IdentityUnavailableError,
    "unreachable",
  );
  identityAnswer = () => Promise.resolve(new Response("overloaded", { status: 503 }));
  await assertRejects(
    () => projectResolver.resolveProjectId("working-key"),
    IdentityUnavailableError,
    "status 503",
  );
  identityAnswer = () => Promise.resolve(Response.json({ projectId: "project-one" }));
  assertEquals(await projectResolver.resolveProjectId("working-key"), "project-one");
});
