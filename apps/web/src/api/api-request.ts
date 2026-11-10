import type { ErrorResponse } from "@extispex/contracts";

/** A failed request to the REST API, with the message the API gave. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly statusCode: number,
    /** The whole error body, for responses that say more than a message. */
    readonly responseBody: unknown = null,
  ) {
    super(message);
  }
}

/** Whether the browser's sign-in has ended, so that the user must sign in again. */
export function isSignInRequired(error: unknown): boolean {
  return error instanceof ApiError && error.statusCode === 401;
}

/**
 * Where requests get their access token. The token lasts a few minutes, so the object stays the
 * same while its tokens change, and pages do not reload when a token is renewed.
 */
export interface ApiCredentials {
  /** A token that is valid now. */
  readAccessToken(): Promise<string>;
  /** A new token, after a request was refused with the current one. */
  renewAccessToken(): Promise<string>;
}

interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as it is, such as the text of an uploaded file. */
  textBody?: { text: string; contentType: string };
}

/**
 * Calls the Gateway with an access token. A 401 gets one more try with a new token, in case the
 * token expired on the way. Resolves to null for an empty response.
 */
export async function requestJson<ResponseBody>(
  credentials: ApiCredentials,
  path: string,
  options: ApiRequestOptions = {},
): Promise<ResponseBody> {
  let response = await sendRequest(await credentials.readAccessToken(), path, options);
  if (response.status === 401) {
    await response.body?.cancel();
    response = await sendRequest(await credentials.renewAccessToken(), path, options);
  }
  return await readJsonResponse<ResponseBody>(response);
}

function sendRequest(
  accessToken: string,
  path: string,
  { method = "GET", body, textBody }: ApiRequestOptions,
): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${accessToken}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (textBody !== undefined) headers.set("content-type", textBody.contentType);
  return fetch(path, {
    method,
    headers,
    body: textBody?.text ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

/** The response's JSON body, or an {@link ApiError} with the API's message. */
export async function readJsonResponse<ResponseBody>(response: Response): Promise<ResponseBody> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as ErrorResponse | null;
    throw new ApiError(
      errorBody?.error.message ?? `The request failed with status ${response.status}.`,
      response.status,
      errorBody,
    );
  }
  if (response.status === 204) return null as ResponseBody;
  return await response.json() as ResponseBody;
}
