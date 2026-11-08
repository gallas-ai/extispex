import { type ApiCredentials, ApiError } from "../api/api-request.ts";
import { requestAccessToken } from "../api/sign-in-api.ts";

/** A token is renewed this long before it expires, so that it never expires on the way. */
const RENEWAL_MARGIN_MILLISECONDS = 30_000;

/**
 * Access tokens for one Project, or for managing access when `projectId` is null. Tokens live
 * only in memory: a reload gets a new one with the sign-in cookie. `onSignedOut` runs when the
 * sign-in has ended, so that the app can show the sign-in page.
 */
export function createAccessTokenCredentials(
  projectId: string | null,
  onSignedOut: () => void,
): ApiCredentials {
  let currentToken: { accessToken: string; renewAtMilliseconds: number } | null = null;
  let pendingToken: Promise<string> | null = null;

  const fetchToken = () => {
    pendingToken ??= (async () => {
      try {
        const tokenResponse = await requestAccessToken(projectId === null ? {} : { projectId });
        currentToken = {
          accessToken: tokenResponse.accessToken,
          renewAtMilliseconds: Date.parse(tokenResponse.expiresAt) - RENEWAL_MARGIN_MILLISECONDS,
        };
        return tokenResponse.accessToken;
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 401) onSignedOut();
        throw error;
      } finally {
        pendingToken = null;
      }
    })();
    return pendingToken;
  };

  return {
    readAccessToken: async () =>
      currentToken !== null && currentToken.renewAtMilliseconds > Date.now()
        ? currentToken.accessToken
        : await fetchToken(),
    renewAccessToken: async () => {
      currentToken = null;
      return await fetchToken();
    },
  };
}
