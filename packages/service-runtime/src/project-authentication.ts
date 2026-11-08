import {
  MAXIMUM_API_KEY_LENGTH,
  type ResolveApiKeyRequest,
  resolveApiKeyRoute,
  type ResolvedApiKey,
} from "@extispex/contracts";
import type { ServiceClient } from "@extispex/service-client";

import { IdentityUnavailableError } from "./identity-unavailable-error.ts";

/** Finds the Project that an API key belongs to. */
export interface ProjectResolver {
  /**
   * Resolves to the Project's ID, or null for an unknown or revoked key. Rejects with
   * {@link IdentityUnavailableError} when the answer cannot be obtained.
   */
  resolveProjectId(apiKey: string): Promise<string | null>;
}

/** How long Identity's answer for one key is reused, which bounds how late a revocation acts. */
export const API_KEY_CACHE_MILLISECONDS = 60_000;
const MAXIMUM_CACHED_API_KEYS = 10_000;

export interface IdentityProjectResolverOptions {
  /** A client that sends a service token, as `createServiceTokenClient` returns. */
  identityClient: ServiceClient;
  cacheMilliseconds?: number;
  maximumCachedApiKeys?: number;
  readCurrentTime?: () => Date;
}

interface CachedResolution {
  projectId: string | null;
  expiresAtMilliseconds: number;
}

/**
 * Asks Identity which Project an API key belongs to, and reuses each answer, positive or negative,
 * for a minute. Concurrent requests with the same key share one call. The cache is keyed by the
 * key's SHA-256 hash, so the keys themselves are not kept in memory longer than a request.
 */
export function createIdentityProjectResolver(
  options: IdentityProjectResolverOptions,
): ProjectResolver {
  const cacheMilliseconds = options.cacheMilliseconds ?? API_KEY_CACHE_MILLISECONDS;
  const maximumCachedApiKeys = options.maximumCachedApiKeys ?? MAXIMUM_CACHED_API_KEYS;
  const readCurrentTime = options.readCurrentTime ?? (() => new Date());
  // A Map iterates in insertion order, so re-inserting on use makes the first entry the least
  // recently used one.
  const cachedResolutions = new Map<string, CachedResolution>();
  const pendingResolutions = new Map<string, Promise<string | null>>();

  const askIdentity = async (apiKey: string): Promise<string | null> => {
    const requestBody: ResolveApiKeyRequest = { apiKey };
    let response: Response;
    try {
      response = await options.identityClient(
        new Request(`http://identity${resolveApiKeyRoute.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        }),
      );
    } catch (error) {
      throw new IdentityUnavailableError("The Identity service is unreachable.", {
        cause: error,
      });
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new IdentityUnavailableError(
        `The Identity service answered with status ${response.status}.`,
      );
    }
    return (await response.json() as ResolvedApiKey).projectId;
  };

  const rememberResolution = (cacheKey: string, projectId: string | null) => {
    cachedResolutions.delete(cacheKey);
    cachedResolutions.set(cacheKey, {
      projectId,
      expiresAtMilliseconds: readCurrentTime().getTime() + cacheMilliseconds,
    });
    while (cachedResolutions.size > maximumCachedApiKeys) {
      cachedResolutions.delete(cachedResolutions.keys().next().value as string);
    }
  };

  return {
    async resolveProjectId(apiKey) {
      if (apiKey.length > MAXIMUM_API_KEY_LENGTH) return null;
      const cacheKey = await hashForCache(apiKey);
      const cachedResolution = cachedResolutions.get(cacheKey);
      if (cachedResolution !== undefined) {
        if (cachedResolution.expiresAtMilliseconds > readCurrentTime().getTime()) {
          cachedResolutions.delete(cacheKey);
          cachedResolutions.set(cacheKey, cachedResolution);
          return cachedResolution.projectId;
        }
        cachedResolutions.delete(cacheKey);
      }
      const pendingResolution = pendingResolutions.get(cacheKey);
      if (pendingResolution !== undefined) return await pendingResolution;
      const resolution = askIdentity(apiKey);
      pendingResolutions.set(cacheKey, resolution);
      try {
        const projectId = await resolution;
        rememberResolution(cacheKey, projectId);
        return projectId;
      } finally {
        pendingResolutions.delete(cacheKey);
      }
    },
  };
}

async function hashForCache(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Returns the bearer token from an `Authorization` header value, or null. */
export function extractBearerToken(authorizationHeader: string | null | undefined): string | null {
  const bearerMatch = authorizationHeader?.match(/^Bearer\s+(\S+)$/i);
  return bearerMatch ? bearerMatch[1] : null;
}
