import { ACCESS_TOKEN_ALGORITHM, type PublicKeySet, type Role } from "@extispex/contracts";
import {
  type AccessTokenSigningKey,
  type AccessTokenVerifier,
  createAccessTokenVerifier,
  createSecretCipher,
  InvalidConfigurationError,
  isSealedSecret,
  type SecretCipher,
  signAccessToken,
} from "@extispex/service-runtime";
import { generateTimeOrderedId, type IdentityDatabase, SigningKeyRecord } from "../storage/mod.ts";

/** Short enough that a removed Role or a deactivated user loses access within five minutes. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 300;

const SIGNING_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The cipher that protects the private signing keys in Identity's database. */
export function createSigningKeyCipher(masterKey: string): Promise<SecretCipher> {
  return createSecretCipher(masterKey, "identity-signing-key");
}

/**
 * Run before the service starts. Encrypts private keys stored by an earlier version, and fails at
 * once when the master key cannot open a stored key, rather than at the first sign-in. The update
 * only applies to a value that is still in plain text, so replicas starting together are safe.
 */
export async function protectStoredSigningKeys(
  database: IdentityDatabase,
  signingKeyCipher: SecretCipher,
): Promise<void> {
  const entityManager = database.orm.em.fork();
  for (const storedKey of await entityManager.find(SigningKeyRecord, {})) {
    if (!isSealedSecret(storedKey.sealedPrivateKeyJwk)) {
      await entityManager.nativeUpdate(
        SigningKeyRecord,
        { id: storedKey.id, sealedPrivateKeyJwk: storedKey.sealedPrivateKeyJwk },
        {
          sealedPrivateKeyJwk: await signingKeyCipher.seal(
            storedKey.sealedPrivateKeyJwk,
            storedKey.id,
          ),
        },
      );
      continue;
    }
    try {
      await signingKeyCipher.open(storedKey.sealedPrivateKeyJwk, storedKey.id);
    } catch (error) {
      throw new InvalidConfigurationError(
        "MASTER_KEY cannot open the signing keys in Identity's database. Is it the key this " +
          "Instance was set up with?",
        { cause: error },
      );
    }
  }
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresAt: Date;
}

/** Signs Identity's access tokens and publishes the keys that verify them. */
export interface AccessTokenSigner {
  issueAccessToken(
    subject: string,
    projectAccess: { projectId: string; role: Role } | null,
  ): Promise<IssuedAccessToken>;
  /** Every stored public key, read from the database each time. */
  readPublicKeySet(): Promise<PublicKeySet>;
  /** Verifies tokens with the stored keys, as the other services do with the JWKS endpoint. */
  accessTokenVerifier: AccessTokenVerifier;
}

/**
 * Keeps the signing keys in Identity's database, so that every replica signs with the same key.
 * The first token creates a key when there is none. When replicas create one at once, both keys
 * stay valid and every replica signs with the oldest.
 */
export function createAccessTokenSigner(
  database: IdentityDatabase,
  signingKeyCipher: SecretCipher,
  readCurrentTime: () => Date,
): AccessTokenSigner {
  let signingKey: Promise<AccessTokenSigningKey> | null = null;

  const readStoredKeys = () =>
    database.orm.em.fork().find(SigningKeyRecord, {}, { orderBy: { createdAt: "asc", id: "asc" } });

  const loadSigningKey = async (): Promise<AccessTokenSigningKey> => {
    let storedKeys = await readStoredKeys();
    if (storedKeys.length === 0) {
      await database.orm.em.fork().insert(SigningKeyRecord, await generateSigningKey());
      storedKeys = await readStoredKeys();
    }
    const oldestKey = storedKeys[0];
    return {
      keyId: oldestKey.id,
      privateKey: await crypto.subtle.importKey(
        "jwk",
        JSON.parse(await signingKeyCipher.open(oldestKey.sealedPrivateKeyJwk, oldestKey.id)),
        SIGNING_KEY_ALGORITHM,
        false,
        ["sign"],
      ),
    };
  };

  const generateSigningKey = async () => {
    const keyPair = await crypto.subtle.generateKey(SIGNING_KEY_ALGORITHM, true, [
      "sign",
      "verify",
    ]) as CryptoKeyPair;
    const createdAt = readCurrentTime();
    const id = generateTimeOrderedId(createdAt);
    return {
      id,
      sealedPrivateKeyJwk: await signingKeyCipher.seal(
        JSON.stringify(await crypto.subtle.exportKey("jwk", keyPair.privateKey)),
        id,
      ),
      publicKeyJwk: JSON.stringify(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
      createdAt,
    };
  };

  const readPublicKeySet = async (): Promise<PublicKeySet> => ({
    keys: (await readStoredKeys()).map((storedKey) => ({
      ...JSON.parse(storedKey.publicKeyJwk),
      kid: storedKey.id,
      alg: ACCESS_TOKEN_ALGORITHM,
      use: "sig",
    })),
  });

  return {
    async issueAccessToken(subject, projectAccess) {
      signingKey ??= loadSigningKey().catch((error) => {
        signingKey = null;
        throw error;
      });
      const issuedAt = readCurrentTime();
      const expiresAt = new Date(issuedAt.getTime() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000);
      const accessToken = await signAccessToken(await signingKey, {
        subject,
        projectAccess,
        issuedAt,
        expiresAt,
      });
      return { accessToken, expiresAt };
    },
    readPublicKeySet,
    accessTokenVerifier: createAccessTokenVerifier({ readPublicKeySet, readCurrentTime }),
  };
}
