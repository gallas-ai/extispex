import type { ErrorResponse } from "@extispex/contracts";

/** A failed request to the REST API, with the message the API gave. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export function isApiKeyRejection(error: unknown): boolean {
  return error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403);
}

interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

/** Calls the Gateway with the Project API key. Resolves to null for an empty response. */
export async function requestJson<ResponseBody>(
  apiKey: string,
  path: string,
  { method = "GET", body }: ApiRequestOptions = {},
): Promise<ResponseBody> {
  const headers = new Headers({ authorization: `Bearer ${apiKey}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as ErrorResponse | null;
    throw new ApiError(
      errorBody?.error.message ?? `The request failed with status ${response.status}.`,
      response.status,
    );
  }
  if (response.status === 204) return null as ResponseBody;
  return await response.json() as ResponseBody;
}
