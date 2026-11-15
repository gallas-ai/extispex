import {
  InvalidConfigurationError,
  readOptionalEnvironmentVariable,
  readRequiredEnvironmentVariable,
} from "./environment-variables.ts";

const MASTER_KEY_BYTE_LENGTH = 32;
const INITIALIZATION_VECTOR_BYTE_LENGTH = 12;
/** Before key IDs: `aes256gcm.v1.<IV>.<ciphertext>`, sealed with whichever master key was set. */
const UNIDENTIFIED_KEY_PREFIX = "aes256gcm.v1";
/** `aes256gcm.v2.<key ID>.<IV>.<ciphertext>`: the key ID names the master key that sealed it. */
const IDENTIFIED_KEY_PREFIX = "aes256gcm.v2";
const KEY_ID_BYTE_LENGTH = 8;

/**
 * The master keys a service holds: the current one seals, and a previous one, during a rotation,
 * still opens what it sealed. From `MASTER_KEY` and `PREVIOUS_MASTER_KEY`.
 */
export interface MasterKeys {
  current: string;
  previous?: string;
}

/** Encrypts secrets at rest with AES-256-GCM. */
export interface SecretCipher {
  /** `associatedData` binds the result to its record, so it cannot be moved to another one. */
  seal(plaintext: string, associatedData: string): Promise<string>;
  /** Rejects when no key held opens it, or the value or its associated data were changed. */
  open(sealedSecret: string, associatedData: string): Promise<string>;
  /** Whether a sealed value needs sealing again: it was not sealed with the current master key. */
  needsResealing(sealedSecret: string): boolean;
  /** The ID of the current master key, as sealed values carry it. */
  readonly currentKeyId: string;
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
  return storedValue.startsWith(`${UNIDENTIFIED_KEY_PREFIX}.`) ||
    storedValue.startsWith(`${IDENTIFIED_KEY_PREFIX}.`);
}

/** A new master key: 32 random bytes in base64. */
export function generateMasterKey(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTE_LENGTH))),
  );
}

function decodeMasterKey(masterKey: string, variableName: string): Uint8Array<ArrayBuffer> {
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = decodeBase64(masterKey);
  } catch {
    keyBytes = new Uint8Array();
  }
  if (keyBytes.length !== MASTER_KEY_BYTE_LENGTH) {
    throw new InvalidConfigurationError(
      `${variableName} must be ${MASTER_KEY_BYTE_LENGTH} bytes in base64. Create one with ` +
        "`openssl rand -base64 32`.",
    );
  }
  return keyBytes;
}

interface DerivedKey {
  keyId: string;
  encryptionKey: CryptoKey;
}

/**
 * Derives a purpose's AES key and the master key's ID with HKDF. The ID is the same for every
 * purpose and reveals nothing about the key: it only tells which master key sealed a value.
 */
async function deriveKey(
  masterKey: string,
  variableName: string,
  purpose: string,
): Promise<DerivedKey> {
  const derivationKey = await crypto.subtle.importKey(
    "raw",
    decodeMasterKey(masterKey, variableName),
    "HKDF",
    false,
    ["deriveKey", "deriveBits"],
  );
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(32),
    info: encodeText(info),
  });
  const encryptionKey = await crypto.subtle.deriveKey(
    hkdf(`extispex/${purpose}`),
    derivationKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const keyIdBits = await crypto.subtle.deriveBits(
    hkdf("extispex/master-key-id"),
    derivationKey,
    KEY_ID_BYTE_LENGTH * 8,
  );
  return { keyId: encodeBase64Url(new Uint8Array(keyIdBits)), encryptionKey };
}

/** The ID that values sealed with this master key carry, for logs and documentation. */
export async function readMasterKeyId(masterKey: string): Promise<string> {
  return (await deriveKey(masterKey, "The master key", "key-id")).keyId;
}

/**
 * A cipher for one purpose, such as Target credentials. Each purpose derives its own key from the
 * master key with HKDF, so that a value sealed for one purpose cannot be opened for another.
 *
 * During a rotation it holds two master keys: it seals with the current one and opens values of
 * either, by the key ID they carry. Values sealed before key IDs existed are tried with both.
 */
export async function createSecretCipher(
  masterKeys: string | MasterKeys,
  purpose: string,
): Promise<SecretCipher> {
  const { current, previous } = typeof masterKeys === "string"
    ? { current: masterKeys, previous: undefined }
    : masterKeys;
  const currentKey = await deriveKey(current, "MASTER_KEY", purpose);
  const heldKeys = [currentKey];
  if (previous !== undefined) {
    const previousKey = await deriveKey(previous, "PREVIOUS_MASTER_KEY", purpose);
    if (previousKey.keyId === currentKey.keyId) {
      throw new InvalidConfigurationError("PREVIOUS_MASTER_KEY is the same as MASTER_KEY.");
    }
    heldKeys.push(previousKey);
  }

  const decrypt = async (
    key: DerivedKey,
    iv: string,
    ciphertext: string,
    associatedData: string,
  ) =>
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBase64(iv),
          additionalData: encodeText(associatedData),
        },
        key.encryptionKey,
        decodeBase64(ciphertext),
      ),
    );

  return {
    currentKeyId: currentKey.keyId,
    async seal(plaintext, associatedData) {
      const iv = crypto.getRandomValues(new Uint8Array(INITIALIZATION_VECTOR_BYTE_LENGTH));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encodeText(associatedData) },
        currentKey.encryptionKey,
        encodeText(plaintext),
      );
      return [
        IDENTIFIED_KEY_PREFIX,
        currentKey.keyId,
        encodeBase64Url(iv),
        encodeBase64Url(new Uint8Array(ciphertext)),
      ].join(".");
    },
    async open(sealedSecret, associatedData) {
      if (sealedSecret.startsWith(`${IDENTIFIED_KEY_PREFIX}.`)) {
        const [keyId, iv, ciphertext] = sealedSecret.slice(IDENTIFIED_KEY_PREFIX.length + 1)
          .split(".");
        const key = heldKeys.find((heldKey) => heldKey.keyId === keyId);
        if (key === undefined) {
          throw new Error(
            `This value was sealed with the master key ${keyId}, which is neither MASTER_KEY nor ` +
              "PREVIOUS_MASTER_KEY.",
          );
        }
        return await decrypt(key, iv, ciphertext, associatedData);
      }
      if (!sealedSecret.startsWith(`${UNIDENTIFIED_KEY_PREFIX}.`)) {
        throw new Error("This value is not a sealed secret.");
      }
      const [iv, ciphertext] = sealedSecret.slice(UNIDENTIFIED_KEY_PREFIX.length + 1).split(".");
      let lastError: unknown;
      for (const key of heldKeys) {
        try {
          return await decrypt(key, iv, ciphertext, associatedData);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    needsResealing(sealedSecret) {
      return !sealedSecret.startsWith(`${IDENTIFIED_KEY_PREFIX}.${currentKey.keyId}.`);
    },
  };
}

/** `MASTER_KEY`, and `PREVIOUS_MASTER_KEY` while a rotation is under way. */
export function readMasterKeys(): MasterKeys {
  const previous = readOptionalEnvironmentVariable("PREVIOUS_MASTER_KEY");
  return {
    current: readRequiredEnvironmentVariable("MASTER_KEY"),
    ...(previous === undefined ? {} : { previous }),
  };
}

/** One stored sealed value and the record it is bound to. */
export interface StoredSealedSecret {
  /** The associated data it was sealed with, such as the record's ID. */
  associatedData: string;
  sealedSecret: string;
}

export interface ResealOutcome {
  /** Values sealed again with the current master key. */
  resealedCount: number;
  /** Values that were already sealed with it. */
  currentCount: number;
}

/**
 * Seals every value again with the current master key, after a rotation. `replaceSealedSecret`
 * replaces a value only if it is still the one read, so a value that changed in between, or that
 * another run already resealed, is left alone; it answers whether it replaced it.
 */
export async function resealSecrets(
  cipher: SecretCipher,
  storedSecrets: StoredSealedSecret[],
  replaceSealedSecret: (stored: StoredSealedSecret, resealed: string) => Promise<boolean>,
): Promise<ResealOutcome> {
  const outcome: ResealOutcome = { resealedCount: 0, currentCount: 0 };
  for (const stored of storedSecrets) {
    if (!cipher.needsResealing(stored.sealedSecret)) {
      outcome.currentCount++;
      continue;
    }
    const plaintext = await cipher.open(stored.sealedSecret, stored.associatedData);
    const resealed = await cipher.seal(plaintext, stored.associatedData);
    if (await replaceSealedSecret(stored, resealed)) outcome.resealedCount++;
  }
  return outcome;
}
