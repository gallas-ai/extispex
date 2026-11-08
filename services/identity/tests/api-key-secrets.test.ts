import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  areSecretsEqual,
  generateApiKey,
  generateServiceClientSecret,
  hashApiKey,
  readKeyPrefix,
} from "../src/api-keys/api-key-secrets.ts";
import { generateTimeOrderedId } from "../src/storage/time-ordered-id.ts";

Deno.test("generates recognisable keys with 256 random bits", () => {
  const generatedKeys = new Set(Array.from({ length: 1_000 }, generateApiKey));
  assertEquals(generatedKeys.size, 1_000);
  for (const apiKey of generatedKeys) assertMatch(apiKey, /^extispex_[0-9A-Za-z]{43}$/);
  assertMatch(generateServiceClientSecret(), /^extispex_client_[0-9A-Za-z]{43}$/);
});

Deno.test("uses every base62 character", () => {
  const usedCharacters = new Set(
    Array.from({ length: 200 }, generateApiKey).join("").slice("extispex_".length),
  );
  for (const expectedCharacter of ["0", "9", "A", "Z", "a", "z"]) {
    assert(usedCharacters.has(expectedCharacter), `${expectedCharacter} never appears.`);
  }
});

Deno.test("hashes keys with SHA-256", async () => {
  assertEquals(
    await hashApiKey("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("keeps only enough of a key to recognise it", () => {
  assertEquals(
    readKeyPrefix("extispex_7Hq2kP9xVb3mRt8LwN4cYf6ZjD1sGa5eUo0iKh2QpXr"),
    "extispex_7Hq2kP9x",
  );
  assertEquals(readKeyPrefix("bootstrap-key-with-at-least-thirty-two-characters"), "bootstra");
});

Deno.test("compares secrets", async () => {
  assert(await areSecretsEqual("same-secret", "same-secret"));
  assert(!await areSecretsEqual("same-secret", "same-secreT"));
  assert(!await areSecretsEqual("short", "a-much-longer-secret"));
});

Deno.test("generates UUIDv7 IDs that sort by creation time", () => {
  const earlierId = generateTimeOrderedId(new Date("2026-11-07T10:00:00Z"));
  const laterId = generateTimeOrderedId(new Date("2026-11-07T10:00:00.001Z"));
  assertMatch(earlierId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assertEquals(earlierId.slice(0, 13), "01a1b573-6100");
  assert(earlierId < laterId);
  assertNotEquals(earlierId, generateTimeOrderedId(new Date("2026-11-07T10:00:00Z")));
});
