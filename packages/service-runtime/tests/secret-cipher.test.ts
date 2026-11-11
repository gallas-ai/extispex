import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { InvalidConfigurationError } from "../src/environment-variables.ts";
import { createSecretCipher, generateMasterKey, isSealedSecret } from "../src/secret-cipher.ts";

Deno.test("opens what it sealed, and every seal differs", async () => {
  const cipher = await createSecretCipher(generateMasterKey(), "test");
  const first = await cipher.seal("Bearer secret-token", "target-1");
  const second = await cipher.seal("Bearer secret-token", "target-1");
  assertNotEquals(first, second);
  assert(!first.includes("secret-token"));
  assert(isSealedSecret(first));
  assertEquals(await cipher.open(first, "target-1"), "Bearer secret-token");
});

Deno.test("refuses a value moved to another record", async () => {
  const cipher = await createSecretCipher(generateMasterKey(), "test");
  const sealed = await cipher.seal("secret", "target-1");
  await assertRejects(() => cipher.open(sealed, "target-2"));
});

Deno.test("refuses another master key and another purpose", async () => {
  const masterKey = generateMasterKey();
  const sealed = await (await createSecretCipher(masterKey, "one")).seal("secret", "record");
  const otherKey = await createSecretCipher(generateMasterKey(), "one");
  await assertRejects(() => otherKey.open(sealed, "record"));
  const otherPurpose = await createSecretCipher(masterKey, "two");
  await assertRejects(() => otherPurpose.open(sealed, "record"));
});

Deno.test("refuses a changed value and plain text", async () => {
  const cipher = await createSecretCipher(generateMasterKey(), "test");
  const sealed = await cipher.seal("secret", "record");
  // A character inside the ciphertext, whose every bit counts; the last one may carry unused bits.
  const position = sealed.lastIndexOf(".") + 4;
  const changedCharacter = sealed[position] === "A" ? "B" : "A";
  const changed = sealed.slice(0, position) + changedCharacter + sealed.slice(position + 1);
  await assertRejects(() => cipher.open(changed, "record"));
  await assertRejects(() => cipher.open("secret", "record"), Error, "not a sealed secret");
  assert(!isSealedSecret('{"kty":"EC"}'));
});

Deno.test("refuses a master key of the wrong length", async () => {
  await assertRejects(
    () => createSecretCipher(btoa("too short"), "test"),
    InvalidConfigurationError,
    "32 bytes",
  );
});
