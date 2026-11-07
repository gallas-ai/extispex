/**
 * Every generated key starts with this prefix, so that secret scanners and people recognise an
 * Extispex key, as GitHub's `ghp_` and GitLab's `glpat-` do.
 */
export const API_KEY_PREFIX = "extispex_";

/** 43 base62 characters carry 256 random bits. */
const RANDOM_CHARACTER_COUNT = 43;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** The largest multiple of 62 below 256: bytes from here up would favour the first characters. */
const UNBIASED_BYTE_LIMIT = 248;

/** How many random characters after the prefix stay readable, to tell keys apart. */
const SHOWN_RANDOM_CHARACTER_COUNT = 8;

/**
 * The shortest key Identity accepts from configuration, such as `BOOTSTRAP_PROJECT_API_KEY`.
 * Generated keys are always longer.
 */
export const MINIMUM_CONFIGURED_KEY_LENGTH = 32;

/** Generated Instance admin keys have their own prefix, so that nobody mistakes one for a Project key. */
export const INSTANCE_ADMIN_KEY_PREFIX = "extispex_admin_";

/** A new Project API key: `extispex_` followed by 43 random base62 characters. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${generateRandomCharacters()}`;
}

/** A new Instance admin key, for an Instance that does not set `INSTANCE_ADMIN_KEY`. */
export function generateInstanceAdminKey(): string {
  return `${INSTANCE_ADMIN_KEY_PREFIX}${generateRandomCharacters()}`;
}

function generateRandomCharacters(): string {
  let randomCharacters = "";
  while (randomCharacters.length < RANDOM_CHARACTER_COUNT) {
    for (const randomByte of crypto.getRandomValues(new Uint8Array(64))) {
      if (randomByte < UNBIASED_BYTE_LIMIT && randomCharacters.length < RANDOM_CHARACTER_COUNT) {
        randomCharacters += BASE62_ALPHABET[randomByte % BASE62_ALPHABET.length];
      }
    }
  }
  return randomCharacters;
}

/**
 * The key's SHA-256 hash as hex. A fast hash is enough because keys are long random strings, not
 * passwords: nobody can try enough candidates to find one, and lookups stay one indexed query.
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The part of a key that is stored readable and shown in the UI: the prefix and 8 random
 * characters, or the first 8 characters of a configured key without the prefix.
 */
export function readKeyPrefix(apiKey: string): string {
  return apiKey.startsWith(API_KEY_PREFIX)
    ? apiKey.slice(0, API_KEY_PREFIX.length + SHOWN_RANDOM_CHARACTER_COUNT)
    : apiKey.slice(0, SHOWN_RANDOM_CHARACTER_COUNT);
}

/** Compares two secrets in time that does not depend on where they differ. */
export async function areSecretsEqual(firstSecret: string, secondSecret: string): Promise<boolean> {
  const [firstDigest, secondDigest] = await Promise.all(
    [firstSecret, secondSecret].map(async (secret) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))
    ),
  );
  let difference = 0;
  for (let byteIndex = 0; byteIndex < firstDigest.length; byteIndex++) {
    difference |= firstDigest[byteIndex] ^ secondDigest[byteIndex];
  }
  return difference === 0;
}
