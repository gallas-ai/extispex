import { errorResponseSchema } from "./error-response.ts";

/** Every public endpoint takes the Project API key as `Authorization: Bearer <key>`. */
export const API_KEY_SECURITY_SCHEME_NAME = "apiKey";
export const API_KEY_SECURITY_SCHEME = { type: "http", scheme: "bearer" } as const;
export const apiKeySecurity = [{ [API_KEY_SECURITY_SCHEME_NAME]: [] }];

export function describeErrorResponse(description: string) {
  return { description, content: { "application/json": { schema: errorResponseSchema } } };
}

export const commonErrorResponses = {
  400: describeErrorResponse("The request is invalid."),
  401: describeErrorResponse("The API key is missing or invalid."),
};
