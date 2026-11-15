import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { InvalidConfigurationError } from "../src/environment-variables.ts";
import {
  createSecretCipher,
  generateMasterKey,
  isSealedSecret,
  readMasterKeyId,
  resealSecrets,
} from "../src/secret-cipher.ts";

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

Deno.test("names the master key that sealed a value, and only that key opens it", async () => {
  const oldKey = generateMasterKey();
  const newKey = generateMasterKey();
  const oldCipher = await createSecretCipher(oldKey, "test");
  const sealed = await oldCipher.seal("secret", "record");
  assert(sealed.startsWith(`aes256gcm.v2.${await readMasterKeyId(oldKey)}.`));
  assertEquals(oldCipher.needsResealing(sealed), false);
  const newOnly = await createSecretCipher(newKey, "test");
  await assertRejects(() => newOnly.open(sealed, "record"), Error, "PREVIOUS_MASTER_KEY");
});

Deno.test("during a rotation, seals with the new key and opens with both", async () => {
  const oldKey = generateMasterKey();
  const newKey = generateMasterKey();
  const sealedWithOld = await (await createSecretCipher(oldKey, "test")).seal("old", "record");
  const rotating = await createSecretCipher({ current: newKey, previous: oldKey }, "test");
  assertEquals(await rotating.open(sealedWithOld, "record"), "old");
  assertEquals(rotating.needsResealing(sealedWithOld), true);
  const sealedWithNew = await rotating.seal("new", "record");
  assertEquals(rotating.needsResealing(sealedWithNew), false);
  assertEquals(
    await (await createSecretCipher(newKey, "test")).open(sealedWithNew, "record"),
    "new",
  );
  await assertRejects(
    () => createSecretCipher({ current: newKey, previous: newKey }, "test"),
    InvalidConfigurationError,
    "same",
  );
});

Deno.test("opens values sealed before key IDs with either key, and reseals them", async () => {
  const oldKey = generateMasterKey();
  const newKey = generateMasterKey();
  const unidentified = toUnidentifiedFormat(
    await (await createSecretCipher(oldKey, "test")).seal("legacy", "record"),
  );
  assert(isSealedSecret(unidentified));
  const rotating = await createSecretCipher({ current: newKey, previous: oldKey }, "test");
  assertEquals(await rotating.open(unidentified, "record"), "legacy");
  assertEquals(rotating.needsResealing(unidentified), true);
  await assertRejects(async () =>
    (await createSecretCipher(newKey, "test")).open(unidentified, "record")
  );
});

Deno.test("reseals only values that the current key did not seal, and only once", async () => {
  const oldKey = generateMasterKey();
  const newKey = generateMasterKey();
  const oldCipher = await createSecretCipher(oldKey, "test");
  const rotating = await createSecretCipher({ current: newKey, previous: oldKey }, "test");
  const stored = new Map([
    ["one", await oldCipher.seal("first", "one")],
    ["two", await rotating.seal("second", "two")],
    ["three", toUnidentifiedFormat(await oldCipher.seal("third", "three"))],
  ]);
  const replace = (record: { associatedData: string; sealedSecret: string }, resealed: string) => {
    if (stored.get(record.associatedData) !== record.sealedSecret) return Promise.resolve(false);
    stored.set(record.associatedData, resealed);
    return Promise.resolve(true);
  };
  const readStored = () =>
    [...stored].map(([associatedData, sealedSecret]) => ({ associatedData, sealedSecret }));
  assertEquals(await resealSecrets(rotating, readStored(), replace), {
    resealedCount: 2,
    currentCount: 1,
  });
  assertEquals(await resealSecrets(rotating, readStored(), replace), {
    resealedCount: 0,
    currentCount: 3,
  });
  const newOnly = await createSecretCipher(newKey, "test");
  assertEquals(await newOnly.open(stored.get("three")!, "three"), "third");
});

/** The format before key IDs: `aes256gcm.v1.<IV>.<ciphertext>`. */
function toUnidentifiedFormat(sealed: string): string {
  const [, , , iv, ciphertext] = sealed.split(".");
  return `aes256gcm.v1.${iv}.${ciphertext}`;
}
