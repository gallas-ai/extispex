import { InvalidConfigurationError } from "./environment-variables.ts";

const MASTER_KEY_BYTE_LENGTH = 32;
const INITIALIZATION_VECTOR_BYTE_LENGTH = 12;
const SEALED_SECRET_PREFIX = "aes256gcm.v1";

/** Encrypts secrets at rest with AES-256-GCM. */
export interface SecretCipher {
  /** `associatedData` binds the result to its record, so it cannot be moved to another one. */
  seal(plaintext: string, associatedData: string): Promise<string>;
  /** Rejects when the key is wrong or the value or its associated data were changed. */
  open(sealedSecret: string, associatedData: string): Promise<string>;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
}

function encodeText(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

/** Whether a stored value is the result of {@link SecretCipher.seal}, rather than plain text. */
export function isSealedSecret(storedValue: string): boolean {
  return storedValue.startsWith(`${SEALED_SECRET_PREFIX}.`);
}

/** A new master key: 32 random bytes in base64. */
export function generateMasterKey(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTE_LENGTH))),
  );
}

function decodeMasterKey(masterKey: string): Uint8Array<ArrayBuffer> {
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = decodeBase64(masterKey);
  } catch {
    keyBytes = new Uint8Array();
  }
  if (keyBytes.length !== MASTER_KEY_BYTE_LENGTH) {
    throw new InvalidConfigurationError(
      `The master key must be ${MASTER_KEY_BYTE_LENGTH} bytes in base64. Create one with ` +
        "`openssl rand -base64 32`.",
    );
  }
  return keyBytes;
}

/**
 * A cipher for one purpose, such as Target credentials. Each purpose derives its own key from the
 * master key with HKDF, so that a value sealed for one purpose cannot be opened for another.
 */
export async function createSecretCipher(
  masterKey: string,
  purpose: string,
): Promise<SecretCipher> {
  const derivationKey = await crypto.subtle.importKey(
    "raw",
    decodeMasterKey(masterKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: encodeText(`extispex/${purpose}`),
    },
    derivationKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return {
    async seal(plaintext, associatedData) {
      const iv = crypto.getRandomValues(new Uint8Array(INITIALIZATION_VECTOR_BYTE_LENGTH));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encodeText(associatedData) },
        encryptionKey,
        encodeText(plaintext),
      );
      return [
        SEALED_SECRET_PREFIX,
        encodeBase64Url(iv),
        encodeBase64Url(new Uint8Array(ciphertext)),
      ].join(".");
    },
    async open(sealedSecret, associatedData) {
      if (!isSealedSecret(sealedSecret)) throw new Error("This value is not a sealed secret.");
      const [iv, ciphertext] = sealedSecret.slice(SEALED_SECRET_PREFIX.length + 1).split(".");
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBase64(iv),
          additionalData: encodeText(associatedData),
        },
        encryptionKey,
        decodeBase64(ciphertext),
      );
      return new TextDecoder().decode(plaintext);
    },
  };
}
