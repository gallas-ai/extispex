import {
  type AccessTokenResponse,
  type IssueAccessTokenRequest,
  issueServiceTokenRoute,
} from "@extispex/contracts";
import type { ServiceClient } from "@extispex/service-client";
import { IdentityUnavailableError } from "./identity-unavailable-error.ts";

/** Gets this service's own access tokens from Identity. */
export interface ServiceTokenSource {
  /**
   * A token that is valid for at least another minute: for a Project, carrying the Role `viewer`
   * there, or without a Project for Identity's internal API. Rejects with
   * {@link IdentityUnavailableError} when Identity cannot be asked, and with
   * {@link UnknownProjectError} when the Project does not exist.
   */
  readServiceToken(projectId: string | null): Promise<string>;
  /** Drops a cached token that a service refused, so that the next read gets a new one. */
  forgetServiceToken(projectId: string | null): void;
}

/** Identity knows no Project with the ID, or it is deleted. */
export class UnknownProjectError extends Error {
  override name = "UnknownProjectError";
}

export interface IdentityServiceTokenSourceOptions {
  identityClient: ServiceClient;
  /** This service's client ID in Identity's `SERVICE_CLIENTS`, such as `telemetry`. */
  clientId: string;
  clientSecret: string;
  readCurrentTime?: () => Date;
}

/** A token is renewed this long before it expires, so that it never expires on the way. */
const RENEWAL_MARGIN_MILLISECONDS = 60_000;

interface CachedServiceToken {
  accessToken: string;
  renewAtMilliseconds: number;
}

/**
 * Asks Identity for tokens with the OAuth 2.0 client credentials grant and keeps each one until a
 * minute before it expires. Concurrent reads for the same Project share one request.
 */
export function createIdentityServiceTokenSource(
  options: IdentityServiceTokenSourceOptions,
): ServiceTokenSource {
  const readCurrentTime = options.readCurrentTime ?? (() => new Date());
  const basicCredentials = btoa(`${options.clientId}:${options.clientSecret}`);
  const cachedTokens = new Map<string, CachedServiceToken>();
  const pendingTokens = new Map<string, Promise<string>>();

  const askIdentity = async (cacheKey: string, projectId: string | null): Promise<string> => {
    const requestBody: IssueAccessTokenRequest = projectId === null ? {} : { projectId };
    let response: Response;
    try {
      response = await options.identityClient(
        new Request(`http://identity${issueServiceTokenRoute.path}`, {
          method: "POST",
          headers: {
            authorization: `Basic ${basicCredentials}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
        }),
      );
    } catch (error) {
      throw new IdentityUnavailableError("The Identity service is unreachable.", { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) {
        throw new UnknownProjectError(`Project ${projectId} does not exist.`);
      }
      throw new IdentityUnavailableError(
        response.status === 401
          ? `Identity refused the client credentials of ${options.clientId}. Check that ` +
            "IDENTITY_CLIENT_SECRET matches the service's entry in SERVICE_CLIENTS."
          : `The Identity service answered the token request with status ${response.status}.`,
      );
    }
    const { accessToken, expiresAt } = await response.json() as AccessTokenResponse;
    cachedTokens.set(cacheKey, {
      accessToken,
      renewAtMilliseconds: Date.parse(expiresAt) - RENEWAL_MARGIN_MILLISECONDS,
    });
    return accessToken;
  };

  return {
    async readServiceToken(projectId) {
      const cacheKey = projectId ?? "";
      const cachedToken = cachedTokens.get(cacheKey);
      if (
        cachedToken !== undefined &&
        cachedToken.renewAtMilliseconds > readCurrentTime().getTime()
      ) {
        return cachedToken.accessToken;
      }
      const pendingToken = pendingTokens.get(cacheKey);
      if (pendingToken !== undefined) return await pendingToken;
      const tokenRequest = askIdentity(cacheKey, projectId);
      pendingTokens.set(cacheKey, tokenRequest);
      try {
        return await tokenRequest;
      } finally {
        pendingTokens.delete(cacheKey);
      }
    },
    forgetServiceToken(projectId) {
      cachedTokens.delete(projectId ?? "");
    },
  };
}

/**
 * Sends every request with this service's token: without a Project, as Identity's internal API
 * requires, or for the given Project. A refused token is replaced once, for example after
 * Identity's keys changed.
 */
export function createServiceTokenClient(
  serviceClient: ServiceClient,
  serviceTokens: ServiceTokenSource,
  projectId: string | null = null,
): ServiceClient {
  const sendWithToken = async (request: Request) => {
    const authenticatedRequest = new Request(request);
    authenticatedRequest.headers.set(
      "authorization",
      `Bearer ${await serviceTokens.readServiceToken(projectId)}`,
    );
    return await serviceClient(authenticatedRequest);
  };
  return async (request) => {
    // The body can be read only once, so a retry needs its own copy.
    const retryRequest = request.clone();
    const response = await sendWithToken(request);
    if (response.status !== 401) return response;
    await response.body?.cancel();
    serviceTokens.forgetServiceToken(projectId);
    return await sendWithToken(retryRequest);
  };
}
