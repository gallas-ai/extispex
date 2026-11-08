import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  describeErrorResponse,
  SERVICE_CLIENT_SECURITY_SCHEME_NAME,
} from "../openapi-route-parts.ts";
import {
  accessTokenResponseSchema,
  issueAccessTokenRequestSchema,
  roleSchema,
} from "./access-contracts.ts";

/** Identity signs access tokens with ECDSA P-256 and SHA-256, which every JWT library verifies. */
export const ACCESS_TOKEN_ALGORITHM = "ES256";
export const ACCESS_TOKEN_ISSUER = "extispex-identity";
export const ACCESS_TOKEN_AUDIENCE = "extispex";

/** The `sub` of a user's token is `user:<user ID>`, and of a service's `service:<client ID>`. */
export const USER_SUBJECT_PREFIX = "user:";
export const SERVICE_SUBJECT_PREFIX = "service:";

/**
 * The claims of an access token besides the registered ones (`iss`, `aud`, `iat`, `exp`). A token
 * scoped to a Project carries the Project and the caller's Role in it when the token was issued.
 */
export const accessTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  project: z.string().min(1).optional(),
  role: roleSchema.optional(),
});

export type AccessTokenPayload = z.infer<typeof accessTokenPayloadSchema>;

/** A JSON Web Key Set (RFC 7517) with Identity's public signing keys. */
export const publicKeySetSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

export type PublicKeySet = z.infer<typeof publicKeySetSchema>;

/**
 * Identity's public keys, which every service uses to verify access tokens locally. Internal, like
 * every `/internal/` path: the Gateway does not forward it.
 */
export const getPublicKeySetRoute = createRoute({
  method: "get",
  path: "/internal/v1/jwks.json",
  summary: "Get the public keys that verify access tokens.",
  tags: ["Internal"],
  responses: {
    200: {
      description: "The keys, as a JSON Web Key Set.",
      content: { "application/json": { schema: publicKeySetSchema } },
    },
  },
});

/**
 * A service's own access token, through the OAuth 2.0 client credentials grant: the service sends
 * its client ID and secret from the configuration as HTTP Basic authentication.
 */
export const issueServiceTokenRoute = createRoute({
  method: "post",
  path: "/internal/v1/service-tokens",
  summary: "Issue an access token to a service, optionally for one Project.",
  tags: ["Internal"],
  security: [{ [SERVICE_CLIENT_SECURITY_SCHEME_NAME]: [] }],
  request: {
    body: { content: { "application/json": { schema: issueAccessTokenRequestSchema } } },
  },
  responses: {
    200: {
      description: "The token. One for a Project carries the Role `viewer` there.",
      content: { "application/json": { schema: accessTokenResponseSchema } },
    },
    400: describeErrorResponse("The request is invalid."),
    401: describeErrorResponse("The client ID or secret is missing or wrong."),
    404: describeErrorResponse("No Project with this ID exists, or it is deleted."),
  },
});
