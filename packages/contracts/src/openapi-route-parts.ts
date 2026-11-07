import { errorResponseSchema } from "./error-response.ts";

/** Telemetry and Prompt endpoints take the Project API key as `Authorization: Bearer <key>`. */
export const API_KEY_SECURITY_SCHEME_NAME = "apiKey";
export const API_KEY_SECURITY_SCHEME = { type: "http", scheme: "bearer" } as const;
export const apiKeySecurity = [{ [API_KEY_SECURITY_SCHEME_NAME]: [] }];

/**
 * Project and API key management takes the Instance admin key, set by `INSTANCE_ADMIN_KEY`, as
 * `Authorization: Bearer <key>`. It manages Projects but reads no Project's data.
 */
export const INSTANCE_ADMIN_KEY_SECURITY_SCHEME_NAME = "instanceAdminKey";
export const INSTANCE_ADMIN_KEY_SECURITY_SCHEME = { type: "http", scheme: "bearer" } as const;
export const instanceAdminKeySecurity = [{ [INSTANCE_ADMIN_KEY_SECURITY_SCHEME_NAME]: [] }];

/** Every security scheme of the public API, for the OpenAPI documents' components. */
export const PUBLIC_API_SECURITY_SCHEMES = {
  [API_KEY_SECURITY_SCHEME_NAME]: API_KEY_SECURITY_SCHEME,
  [INSTANCE_ADMIN_KEY_SECURITY_SCHEME_NAME]: INSTANCE_ADMIN_KEY_SECURITY_SCHEME,
};

export function describeErrorResponse(description: string) {
  return { description, content: { "application/json": { schema: errorResponseSchema } } };
}

export const commonErrorResponses = {
  400: describeErrorResponse("The request is invalid."),
  401: describeErrorResponse("The API key is missing or invalid."),
  503: describeErrorResponse("The API key could not be checked. Retry later."),
};
