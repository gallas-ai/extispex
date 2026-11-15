import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { accessTokenSecurity, describeErrorResponse } from "../openapi-route-parts.ts";
import { listSigningKeysResponseSchema, signingKeySchema } from "./signing-key-contracts.ts";

const SIGNING_KEY_TAGS = ["Signing keys"];

const instanceAdminErrors = {
  401: describeErrorResponse("The access token is missing, invalid or not a user's."),
  403: describeErrorResponse("This takes an Instance admin."),
};

const keyIdParameters = z.object({ keyId: z.string().min(1).max(64) });

export const listSigningKeysRoute = createRoute({
  method: "get",
  path: "/v1/signing-keys",
  summary: "List the keys that sign access tokens and their state. Takes an Instance admin.",
  tags: SIGNING_KEY_TAGS,
  security: accessTokenSecurity,
  responses: {
    200: {
      description: "Every key, newest first, without its private part.",
      content: { "application/json": { schema: listSigningKeysResponseSchema } },
    },
    ...instanceAdminErrors,
  },
});

export const addSigningKeyRoute = createRoute({
  method: "post",
  path: "/v1/signing-keys",
  summary: "Add a key. It is published at once and can sign after a minute, when services have " +
    "had time to read it. Takes an Instance admin.",
  tags: SIGNING_KEY_TAGS,
  security: accessTokenSecurity,
  responses: {
    201: {
      description: "The new key, published but not signing.",
      content: { "application/json": { schema: signingKeySchema } },
    },
    ...instanceAdminErrors,
  },
});

export const activateSigningKeyRoute = createRoute({
  method: "post",
  path: "/v1/signing-keys/{keyId}/activation",
  summary: "Make this key sign every new access token. The key that signed until now retires and " +
    "is removed once the tokens it signed have expired. Takes an Instance admin.",
  tags: SIGNING_KEY_TAGS,
  security: accessTokenSecurity,
  request: { params: keyIdParameters },
  responses: {
    200: {
      description: "The key, now signing.",
      content: { "application/json": { schema: signingKeySchema } },
    },
    ...instanceAdminErrors,
    404: describeErrorResponse("No key with this ID exists."),
    409: describeErrorResponse(
      "The key is retired, or too new: services may not have read it yet (`canSignFrom`).",
    ),
  },
});

export const retireSigningKeyRoute = createRoute({
  method: "delete",
  path: "/v1/signing-keys/{keyId}",
  summary: "Retire a key that does not sign, such as one added by mistake. It stays published " +
    "until tokens it may have signed have expired. Takes an Instance admin.",
  tags: SIGNING_KEY_TAGS,
  security: accessTokenSecurity,
  request: { params: keyIdParameters },
  responses: {
    200: {
      description: "The key, retired.",
      content: { "application/json": { schema: signingKeySchema } },
    },
    ...instanceAdminErrors,
    404: describeErrorResponse("No key with this ID exists."),
    409: describeErrorResponse("The key signs; activate another key first."),
  },
});

export const signingKeyRoutes = [
  listSigningKeysRoute,
  addSigningKeyRoute,
  activateSigningKeyRoute,
  retireSigningKeyRoute,
];
