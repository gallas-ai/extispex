/**
 * Passwords are stored as PBKDF2-HMAC-SHA256 hashes with a random salt, using 600,000 iterations
 * as OWASP's Password Storage Cheat Sheet advises. WebCrypto computes them, so no native or WASM
 * dependency is needed. The iteration count is stored with each hash, so it can be raised later.
 */
export const DEFAULT_PASSWORD_HASH_ITERATIONS = 600_000;

const HASH_SCHEME = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BITS = 256;

/** `pbkdf2-sha256$<iterations>$<salt, base64>$<hash, base64>`. */
export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordHash(password, salt, iterations);
  return [HASH_SCHEME, iterations, encodeBase64(salt), encodeBase64(hash)].join("$");
}

/** Whether the password matches the stored hash, compared in constant time. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [scheme, iterationsText, saltText, hashText] = storedHash.split("$");
  const iterations = Number(iterationsText);
  if (scheme !== HASH_SCHEME || !Number.isInteger(iterations) || iterations < 1) return false;
  const expectedHash = decodeBase64(hashText);
  const actualHash = await derivePasswordHash(password, decodeBase64(saltText), iterations);
  let difference = expectedHash.length ^ actualHash.length;
  for (let byteIndex = 0; byteIndex < actualHash.length; byteIndex++) {
    difference |= actualHash[byteIndex] ^ (expectedHash[byteIndex] ?? 0);
  }
  return difference === 0;
}

/**
 * A hash to compare against when the email address is unknown, so that a failed sign-in takes as
 * long whether or not the user exists.
 */
export function createDecoyPasswordHash(iterations: number): Promise<string> {
  return hashPassword(crypto.randomUUID(), iterations);
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      passwordKey,
      HASH_BITS,
    ),
  );
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(text: string | undefined): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(text ?? ""), (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}
