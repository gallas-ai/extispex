import type {
  AccessTokenResponse,
  IssueAccessTokenRequest,
  SignInRequest,
  User,
} from "@extispex/contracts";
import { readJsonResponse } from "./api-request.ts";

/**
 * Signs in with a local account. Identity answers with an HttpOnly cookie that only the sign-in
 * endpoints receive, so no script on the page can read it.
 */
export async function signIn(request: SignInRequest): Promise<User> {
  return await readJsonResponse(
    await fetch("/v1/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

export async function signOut(): Promise<void> {
  await readJsonResponse(await fetch("/v1/sign-in", { method: "DELETE" }));
}

/** A short-lived access token for the signed-in browser; 401 when it is not signed in. */
export async function requestAccessToken(
  request: IssueAccessTokenRequest,
): Promise<AccessTokenResponse> {
  return await readJsonResponse(
    await fetch("/v1/sign-in/access-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}
