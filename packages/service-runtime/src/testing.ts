/** Stand-ins for Identity in services' tests. */
import { ACCESS_TOKEN_ALGORITHM, type ProjectLifecycle, type Role } from "@extispex/contracts";
import type { ProjectLifecycleSource } from "./project-lifecycle-client.ts";
import {
  type AccessTokenVerifier,
  createAccessTokenVerifier,
  signAccessToken,
} from "./access-tokens.ts";

export interface TestAccessTokenClaims {
  /** Defaults to `user:test-user`. */
  subject?: string;
  /** Omit both for a token without a Project. */
  projectId?: string;
  role?: Role;
  /** Defaults to 300 seconds; negative for an expired token. */
  expiresInSeconds?: number;
}

export interface TestAccessTokens {
  /** Verifies the tokens below, like the verifier that reads Identity's keys. */
  accessTokenVerifier: AccessTokenVerifier;
  issueAccessToken(claims: TestAccessTokenClaims): Promise<string>;
}

/** A fresh signing key and a verifier that trusts only it. */
export async function createTestAccessTokens(): Promise<TestAccessTokens> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const keyId = crypto.randomUUID();
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return {
    accessTokenVerifier: createAccessTokenVerifier({
      readPublicKeySet: () =>
        Promise.resolve({
          keys: [{ ...publicKey, kid: keyId, alg: ACCESS_TOKEN_ALGORITHM, use: "sig" }],
        }),
    }),
    issueAccessToken: (claims) => {
      const issuedAt = new Date();
      return signAccessToken({ keyId, privateKey: keyPair.privateKey }, {
        subject: claims.subject ?? "user:test-user",
        projectAccess: claims.projectId === undefined || claims.role === undefined
          ? null
          : { projectId: claims.projectId, role: claims.role },
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + (claims.expiresInSeconds ?? 300) * 1000),
      });
    },
  };
}

/** A stand-in for Identity's project lifecycle endpoints, which the test changes as it goes. */
export interface TestProjectLifecycle extends ProjectLifecycleSource {
  /** What Identity answers; change it to delete a Project or set a Retention Period. */
  lifecycle: ProjectLifecycle;
  /** The Project IDs the service reported as removed, in order. */
  recordedRemovals: string[];
}

export function createTestProjectLifecycle(
  lifecycle: ProjectLifecycle = { projects: [], projectsToRemove: [] },
): TestProjectLifecycle {
  const testLifecycle: TestProjectLifecycle = {
    lifecycle,
    recordedRemovals: [],
    readProjectLifecycle: () => Promise.resolve(structuredClone(testLifecycle.lifecycle)),
    recordDataRemoval: (projectId) => {
      testLifecycle.recordedRemovals.push(projectId);
      return Promise.resolve();
    },
  };
  return testLifecycle;
}
