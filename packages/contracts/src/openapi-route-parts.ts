import { errorResponseSchema } from "./error-response.ts";

/** A Project API key as `Authorization: Bearer <key>`, for applications and scripts. */
export const API_KEY_SECURITY_SCHEME_NAME = "apiKey";
export const API_KEY_SECURITY_SCHEME = { type: "http", scheme: "bearer" } as const;

/**
 * An access token from Identity as `Authorization: Bearer <token>`: a short-lived JWT for a user or
 * a service, scoped to at most one Project.
 */
export const ACCESS_TOKEN_SECURITY_SCHEME_NAME = "accessToken";
export const ACCESS_TOKEN_SECURITY_SCHEME = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
} as const;

/** A Project's data takes either a Project API key or an access token scoped to the Project. */
export const projectDataSecurity: Record<string, string[]>[] = [
  { [API_KEY_SECURITY_SCHEME_NAME]: [] },
  { [ACCESS_TOKEN_SECURITY_SCHEME_NAME]: [] },
];

/** Managing users, Groups, Roles, Projects and API keys takes a user's access token. */
export const accessTokenSecurity: Record<string, string[]>[] = [{
  [ACCESS_TOKEN_SECURITY_SCHEME_NAME]: [],
}];

/** A service's client ID and secret from the configuration, for Identity's internal API. */
export const SERVICE_CLIENT_SECURITY_SCHEME_NAME = "serviceClient";
export const SERVICE_CLIENT_SECURITY_SCHEME = { type: "http", scheme: "basic" } as const;

/** Every security scheme of the public API, for the OpenAPI documents' components. */
export const PUBLIC_API_SECURITY_SCHEMES = {
  [API_KEY_SECURITY_SCHEME_NAME]: API_KEY_SECURITY_SCHEME,
  [ACCESS_TOKEN_SECURITY_SCHEME_NAME]: ACCESS_TOKEN_SECURITY_SCHEME,
  [SERVICE_CLIENT_SECURITY_SCHEME_NAME]: SERVICE_CLIENT_SECURITY_SCHEME,
};

export function describeErrorResponse(description: string) {
  return { description, content: { "application/json": { schema: errorResponseSchema } } };
}

export const commonErrorResponses = {
  400: describeErrorResponse("The request is invalid."),
  401: describeErrorResponse("The API key or access token is missing or invalid."),
  403: describeErrorResponse("The caller's Role in the Project does not allow this request."),
  503: describeErrorResponse("The credentials could not be checked. Retry later."),
};
