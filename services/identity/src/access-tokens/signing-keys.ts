import {
  ACCESS_TOKEN_ALGORITHM,
  type PublicKeySet,
  type Role,
  type SigningKey,
} from "@extispex/contracts";
import {
  type AccessTokenSigningKey,
  type AccessTokenVerifier,
  createAccessTokenVerifier,
  createSecretCipher,
  InvalidConfigurationError,
  isSealedSecret,
  type MasterKeys,
  type ResealOutcome,
  resealSecrets,
  type SecretCipher,
  signAccessToken,
} from "@extispex/service-runtime";
import { generateTimeOrderedId, type IdentityDatabase, SigningKeyRecord } from "../storage/mod.ts";

/** Short enough that a removed Role or a deactivated user loses access within five minutes. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 300;

const SIGNING_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The cipher that protects the private signing keys in Identity's database. */
export function createSigningKeyCipher(masterKeys: string | MasterKeys): Promise<SecretCipher> {
  return createSecretCipher(masterKeys, "identity-signing-key");
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

/**
 * Seals every private signing key again with the current master key, after a rotation. A key is
 * replaced only if it is still the value read, so runs at the same time are safe.
 */
export async function resealSigningKeys(
  database: IdentityDatabase,
  signingKeyCipher: SecretCipher,
): Promise<ResealOutcome> {
  const entityManager = database.orm.em.fork();
  const storedKeys = await entityManager.find(SigningKeyRecord, {});
  return await resealSecrets(
    signingKeyCipher,
    storedKeys.filter((storedKey) => isSealedSecret(storedKey.sealedPrivateKeyJwk)).map((
      storedKey,
    ) => ({ associatedData: storedKey.id, sealedSecret: storedKey.sealedPrivateKeyJwk })),
    async (stored, resealed) =>
      await entityManager.nativeUpdate(
        SigningKeyRecord,
        { id: stored.associatedData, sealedPrivateKeyJwk: stored.sealedSecret },
        { sealedPrivateKeyJwk: resealed },
      ) === 1,
  );
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresAt: Date;
}

/**
 * How long a new key is published before it may sign, by default. A service reads the keys again
 * for an unknown key ID at most every 30 seconds, so after a minute every service can know it.
 */
export const DEFAULT_SIGNING_KEY_PUBLICATION_SECONDS = 60;
/** How long a replica keeps using the key it signs with before it asks which key signs now. */
const SIGNING_KEY_CACHE_MILLISECONDS = 30_000;
/**
 * How long a retired key stays published: the longest token lifetime, plus the time other replicas
 * may still sign with it, plus a minute for clocks that differ.
 */
export const RETIRED_SIGNING_KEY_PUBLICATION_SECONDS = ACCESS_TOKEN_LIFETIME_SECONDS +
  SIGNING_KEY_CACHE_MILLISECONDS / 1000 + 60;

export type ActivateSigningKeyResult =
  | { status: "activated"; key: SigningKey }
  | { status: "not_found" }
  | { status: "retired" }
  | { status: "too_new"; canSignFrom: string };

export type RetireSigningKeyResult =
  | { status: "retired"; key: SigningKey }
  | { status: "not_found" }
  | { status: "signing" };

/** Signs Identity's access tokens, publishes the keys that verify them, and rotates them. */
export interface AccessTokenSigner {
  issueAccessToken(
    subject: string,
    projectAccess: { projectId: string; role: Role } | null,
  ): Promise<IssuedAccessToken>;
  /** Every published public key, read from the database each time. */
  readPublicKeySet(): Promise<PublicKeySet>;
  /** Verifies tokens with the stored keys, as the other services do with the JWKS endpoint. */
  accessTokenVerifier: AccessTokenVerifier;
  /** Every key, newest first, without its private part. */
  listSigningKeys(): Promise<SigningKey[]>;
  /** A new key, published at once; it may sign after the publication time. */
  addSigningKey(): Promise<SigningKey>;
  /** Makes a key sign; the key that signed until now retires. */
  activateSigningKey(keyId: string): Promise<ActivateSigningKeyResult>;
  /** Retires a key that does not sign. */
  retireSigningKey(keyId: string): Promise<RetireSigningKeyResult>;
}

export interface AccessTokenSignerOptions {
  /** How long a new key is published before it may sign; tests and e2e runs shorten it. */
  signingKeyPublicationSeconds?: number;
}

type StoredSigningKey = {
  id: string;
  sealedPrivateKeyJwk: string;
  publicKeyJwk: string;
  createdAt: Date;
  activatedAt?: Date | null;
  retiredAt?: Date | null;
};

/**
 * The key that signs: of the keys not retired, the one activated last. Keys from before rotation
 * existed were never activated; then the oldest signs, as it always did, which also settles two
 * replicas that created a first key at once.
 */
function selectSigningKey(storedKeys: StoredSigningKey[]): StoredSigningKey | null {
  const candidates = storedKeys.filter((storedKey) => storedKey.retiredAt == null);
  const activated = candidates.filter((storedKey) => storedKey.activatedAt != null)
    .sort((first, second) =>
      second.activatedAt!.getTime() - first.activatedAt!.getTime() ||
      second.id.localeCompare(first.id)
    );
  if (activated.length > 0) return activated[0];
  return [...candidates].sort((first, second) =>
    first.createdAt.getTime() - second.createdAt.getTime() || first.id.localeCompare(second.id)
  )[0] ?? null;
}

/**
 * Keeps the signing keys in Identity's database, so that every replica signs with the same key.
 * The first token creates a key when there is none. An Instance admin adds a key, which is
 * published at once, and activates it after the publication time; the previous key retires and is
 * removed once every token it signed has expired. Each replica asks which key signs every 30
 * seconds.
 */
export function createAccessTokenSigner(
  database: IdentityDatabase,
  signingKeyCipher: SecretCipher,
  readCurrentTime: () => Date,
  options: AccessTokenSignerOptions = {},
): AccessTokenSigner {
  const publicationMilliseconds = (options.signingKeyPublicationSeconds ??
    DEFAULT_SIGNING_KEY_PUBLICATION_SECONDS) * 1000;
  const retiredPublicationMilliseconds = RETIRED_SIGNING_KEY_PUBLICATION_SECONDS * 1000;
  let cachedSigningKey: { key: Promise<AccessTokenSigningKey>; loadedAt: number } | null = null;

  /** Every published key; retired keys past their publication are removed first. */
  const readStoredKeys = async (): Promise<StoredSigningKey[]> => {
    const entityManager = database.orm.em.fork();
    await entityManager.nativeDelete(SigningKeyRecord, {
      retiredAt: { $lt: new Date(readCurrentTime().getTime() - retiredPublicationMilliseconds) },
    });
    return await entityManager.find(SigningKeyRecord, {}, {
      orderBy: { createdAt: "asc", id: "asc" },
    });
  };

  const describeKey = (
    storedKey: StoredSigningKey,
    signingKeyId: string | null,
  ): SigningKey => ({
    keyId: storedKey.id,
    state: storedKey.retiredAt != null
      ? "retired"
      : storedKey.id === signingKeyId
      ? "signing"
      : "published",
    createdAt: storedKey.createdAt.toISOString(),
    activatedAt: storedKey.activatedAt?.toISOString() ?? null,
    retiredAt: storedKey.retiredAt?.toISOString() ?? null,
    canSignFrom: new Date(storedKey.createdAt.getTime() + publicationMilliseconds).toISOString(),
    removedAt: storedKey.retiredAt == null
      ? null
      : new Date(storedKey.retiredAt.getTime() + retiredPublicationMilliseconds).toISOString(),
  });

  const generateSigningKey = async (activatedAt: Date | null) => {
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
      activatedAt,
      retiredAt: null,
    };
  };

  const loadSigningKey = async (): Promise<AccessTokenSigningKey> => {
    let signingKey = selectSigningKey(await readStoredKeys());
    if (signingKey === null) {
      // The very first key signs at once: no token exists yet that a service must verify.
      await database.orm.em.fork().insert(
        SigningKeyRecord,
        await generateSigningKey(readCurrentTime()),
      );
      signingKey = selectSigningKey(await readStoredKeys())!;
    }
    return {
      keyId: signingKey.id,
      privateKey: await crypto.subtle.importKey(
        "jwk",
        JSON.parse(await signingKeyCipher.open(signingKey.sealedPrivateKeyJwk, signingKey.id)),
        SIGNING_KEY_ALGORITHM,
        false,
        ["sign"],
      ),
    };
  };

  const readSigningKey = (): Promise<AccessTokenSigningKey> => {
    const now = Date.now();
    if (
      cachedSigningKey === null || now - cachedSigningKey.loadedAt > SIGNING_KEY_CACHE_MILLISECONDS
    ) {
      const key = loadSigningKey().catch((error) => {
        cachedSigningKey = null;
        throw error;
      });
      cachedSigningKey = { key, loadedAt: now };
    }
    return cachedSigningKey.key;
  };

  const readPublicKeySet = async (): Promise<PublicKeySet> => ({
    keys: (await readStoredKeys()).map((storedKey) => ({
      ...JSON.parse(storedKey.publicKeyJwk),
      kid: storedKey.id,
      alg: ACCESS_TOKEN_ALGORITHM,
      use: "sig",
    })),
  });

  const listSigningKeys = async (): Promise<SigningKey[]> => {
    const storedKeys = await readStoredKeys();
    const signingKeyId = selectSigningKey(storedKeys)?.id ?? null;
    return storedKeys.map((storedKey) => describeKey(storedKey, signingKeyId)).reverse();
  };

  const findKey = async (keyId: string) => {
    const storedKeys = await readStoredKeys();
    return {
      storedKey: storedKeys.find((candidate) => candidate.id === keyId) ?? null,
      signingKey: selectSigningKey(storedKeys),
    };
  };

  return {
    async issueAccessToken(subject, projectAccess) {
      const issuedAt = readCurrentTime();
      const expiresAt = new Date(issuedAt.getTime() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000);
      const accessToken = await signAccessToken(await readSigningKey(), {
        subject,
        projectAccess,
        issuedAt,
        expiresAt,
      });
      return { accessToken, expiresAt };
    },
    readPublicKeySet,
    // The keys are in Identity's own database, so a token with a key ID it has not seen yet, such
    // as one another replica just started signing with, is checked against the database at once.
    accessTokenVerifier: createAccessTokenVerifier({
      readPublicKeySet,
      readCurrentTime,
      refreshCooldownMilliseconds: 0,
    }),
    listSigningKeys,
    async addSigningKey() {
      // A first key ever signs at once, as the first token would have created it.
      const hasSigningKey = selectSigningKey(await readStoredKeys()) !== null;
      const record = await generateSigningKey(hasSigningKey ? null : readCurrentTime());
      await database.orm.em.fork().insert(SigningKeyRecord, record);
      const signingKeyId = hasSigningKey ? selectSigningKey(await readStoredKeys())!.id : record.id;
      return describeKey(record, signingKeyId);
    },
    async activateSigningKey(keyId) {
      const { storedKey, signingKey } = await findKey(keyId);
      if (storedKey === null) return { status: "not_found" };
      if (storedKey.retiredAt != null) return { status: "retired" };
      if (storedKey.id === signingKey?.id) {
        return { status: "activated", key: describeKey(storedKey, storedKey.id) };
      }
      const now = readCurrentTime();
      const canSignFrom = new Date(storedKey.createdAt.getTime() + publicationMilliseconds);
      if (now < canSignFrom) return { status: "too_new", canSignFrom: canSignFrom.toISOString() };
      await database.orm.em.fork().transactional(async (entityManager) => {
        await entityManager.nativeUpdate(
          SigningKeyRecord,
          { id: storedKey.id, retiredAt: null },
          { activatedAt: now },
        );
        if (signingKey !== null) {
          await entityManager.nativeUpdate(
            SigningKeyRecord,
            { id: signingKey.id, retiredAt: null },
            { retiredAt: now },
          );
        }
      });
      // This replica signs with the new key at once; the others within 30 seconds.
      cachedSigningKey = null;
      return {
        status: "activated",
        key: describeKey({ ...storedKey, activatedAt: now }, storedKey.id),
      };
    },
    async retireSigningKey(keyId) {
      const { storedKey, signingKey } = await findKey(keyId);
      if (storedKey === null) return { status: "not_found" };
      if (storedKey.id === signingKey?.id) return { status: "signing" };
      if (storedKey.retiredAt != null) {
        return { status: "retired", key: describeKey(storedKey, signingKey?.id ?? null) };
      }
      const now = readCurrentTime();
      await database.orm.em.fork().nativeUpdate(
        SigningKeyRecord,
        { id: storedKey.id, retiredAt: null },
        { retiredAt: now },
      );
      return {
        status: "retired",
        key: describeKey({ ...storedKey, retiredAt: now }, signingKey?.id ?? null),
      };
    },
  };
}
