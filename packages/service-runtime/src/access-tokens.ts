import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  type AccessTokenPayload,
  accessTokenPayloadSchema,
  getPublicKeySetRoute,
  type PublicKeySet,
  publicKeySetSchema,
  type Role,
} from "@extispex/contracts";
import type { ServiceClient } from "@extispex/service-client";
import {
  createLocalJWKSet,
  errors as joseErrors,
  type JSONWebKeySet,
  jwtVerify,
  SignJWT,
} from "jose";
import { IdentityUnavailableError } from "./identity-unavailable-error.ts";

/** What a valid access token says about its caller. */
export interface VerifiedAccessToken {
  /** `user:<user ID>` or `service:<client ID>`. */
  subject: string;
  /** The Project the token acts on, or null for a token that only manages access. */
  projectId: string | null;
  /** The caller's Role in the Project when the token was issued, or null without a Project. */
  role: Role | null;
}

/** Checks access tokens locally, with Identity's public keys. */
export interface AccessTokenVerifier {
  /**
   * Resolves to the token's claims, or null for a token that is malformed, expired, or not signed
   * by Identity. Rejects with {@link IdentityUnavailableError} when the keys cannot be obtained.
   */
  verifyAccessToken(accessToken: string): Promise<VerifiedAccessToken | null>;
}

/** Reads Identity's current public keys. */
export type PublicKeySetSource = () => Promise<PublicKeySet>;

export interface AccessTokenVerifierOptions {
  readPublicKeySet: PublicKeySetSource;
  /**
   * The least time between two reads caused by tokens with an unknown key ID, so that forged
   * tokens cannot make every request call Identity.
   */
  refreshCooldownMilliseconds?: number;
  readCurrentTime?: () => Date;
}

const DEFAULT_REFRESH_COOLDOWN_MILLISECONDS = 30_000;

/**
 * Verifies access tokens with keys read once and kept in memory. A token signed with a key ID that
 * is not known yet, as after Identity adds a key, makes it read the keys again.
 */
export function createAccessTokenVerifier(
  options: AccessTokenVerifierOptions,
): AccessTokenVerifier {
  const refreshCooldownMilliseconds = options.refreshCooldownMilliseconds ??
    DEFAULT_REFRESH_COOLDOWN_MILLISECONDS;
  const readCurrentTime = options.readCurrentTime ?? (() => new Date());
  let localKeySet: ReturnType<typeof createLocalJWKSet> | null = null;
  let lastReadMilliseconds = Number.NEGATIVE_INFINITY;
  let pendingRead: Promise<void> | null = null;

  const readKeys = async () => {
    pendingRead ??= (async () => {
      try {
        const publicKeySet = await options.readPublicKeySet();
        localKeySet = createLocalJWKSet(publicKeySet as JSONWebKeySet);
        lastReadMilliseconds = readCurrentTime().getTime();
      } finally {
        pendingRead = null;
      }
    })();
    await pendingRead;
  };

  const verifySignature = async (accessToken: string) => {
    if (localKeySet === null) await readKeys();
    const { payload } = await jwtVerify(accessToken, localKeySet!, {
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      currentDate: readCurrentTime(),
    });
    return payload;
  };

  return {
    async verifyAccessToken(accessToken) {
      let payload: unknown;
      try {
        payload = await verifySignature(accessToken);
      } catch (error) {
        const mayBeNewKey = error instanceof joseErrors.JWKSNoMatchingKey &&
          readCurrentTime().getTime() - lastReadMilliseconds >= refreshCooldownMilliseconds;
        if (!mayBeNewKey) {
          if (error instanceof joseErrors.JOSEError) return null;
          throw error;
        }
        await readKeys();
        try {
          payload = await verifySignature(accessToken);
        } catch (retryError) {
          if (retryError instanceof joseErrors.JOSEError) return null;
          throw retryError;
        }
      }
      const parsedPayload = accessTokenPayloadSchema.safeParse(payload);
      if (!parsedPayload.success) return null;
      const { sub, project, role } = parsedPayload.data;
      // A Project without a Role, or the reverse, is not a token Identity issues.
      if ((project === undefined) !== (role === undefined)) return null;
      return { subject: sub, projectId: project ?? null, role: role ?? null };
    },
  };
}

/** Reads the public keys from Identity's internal JWKS endpoint. */
export function createIdentityPublicKeySetSource(
  identityClient: ServiceClient,
): PublicKeySetSource {
  return async () => {
    let response: Response;
    try {
      response = await identityClient(new Request(`http://identity${getPublicKeySetRoute.path}`));
    } catch (error) {
      throw new IdentityUnavailableError("The Identity service is unreachable.", { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new IdentityUnavailableError(
        `The Identity service answered the key request with status ${response.status}.`,
      );
    }
    return publicKeySetSchema.parse(await response.json());
  };
}

/** A key that signs access tokens, as Identity keeps it. */
export interface AccessTokenSigningKey {
  keyId: string;
  privateKey: CryptoKey;
}

export interface AccessTokenContent {
  subject: string;
  /** The Project and the caller's Role there, or null for a token that only manages access. */
  projectAccess: { projectId: string; role: Role } | null;
  issuedAt: Date;
  expiresAt: Date;
}

/** Signs an access token, for Identity and for tests that stand in for it. */
export async function signAccessToken(
  signingKey: AccessTokenSigningKey,
  content: AccessTokenContent,
): Promise<string> {
  const payload: Omit<AccessTokenPayload, "sub"> = content.projectAccess === null
    ? {}
    : { project: content.projectAccess.projectId, role: content.projectAccess.role };
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid: signingKey.keyId, typ: "JWT" })
    .setSubject(content.subject)
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(Math.floor(content.issuedAt.getTime() / 1000))
    .setExpirationTime(Math.floor(content.expiresAt.getTime() / 1000))
    .sign(signingKey.privateKey);
}
