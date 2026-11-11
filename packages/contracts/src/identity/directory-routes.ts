import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  accessTokenSecurity,
  describeErrorResponse,
  DIRECTORY_TOKEN_SECURITY_SCHEME_NAME,
} from "../openapi-route-parts.ts";
import {
  createdDirectoryTokenSchema,
  createDirectoryTokenRequestSchema,
  directoryImportFailureSchema,
  directoryImportRequestSchema,
  directoryImportSummarySchema,
  directoryStatusSchema,
} from "./directory-contracts.ts";

const DIRECTORY_TAGS = ["Directory sync"];

const instanceAdminErrors = {
  401: describeErrorResponse("The access token is missing, invalid or not a user's."),
  403: describeErrorResponse("This takes an Instance admin."),
};

export const getDirectoryStatusRoute = createRoute({
  method: "get",
  path: "/v1/directory",
  summary: "Show SCIM tokens, Company groups and recent imports. Takes an Instance admin.",
  tags: DIRECTORY_TAGS,
  security: accessTokenSecurity,
  responses: {
    200: {
      description: "The state of the sync with the company's directory.",
      content: { "application/json": { schema: directoryStatusSchema } },
    },
    ...instanceAdminErrors,
  },
});

export const createDirectoryTokenRoute = createRoute({
  method: "post",
  path: "/v1/directory/tokens",
  summary: "Create a token for the company's directory. It is shown once. Takes an Instance admin.",
  tags: DIRECTORY_TAGS,
  security: accessTokenSecurity,
  request: {
    body: {
      content: { "application/json": { schema: createDirectoryTokenRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "The new token, including its secret value.",
      content: { "application/json": { schema: createdDirectoryTokenSchema } },
    },
    400: describeErrorResponse("The request is invalid."),
    ...instanceAdminErrors,
  },
});

export const revokeDirectoryTokenRoute = createRoute({
  method: "delete",
  path: "/v1/directory/tokens/{tokenId}",
  summary: "Revoke a directory token, at once. Takes an Instance admin.",
  tags: DIRECTORY_TAGS,
  security: accessTokenSecurity,
  request: { params: z.object({ tokenId: z.string().min(1).max(64) }) },
  responses: {
    204: { description: "The token no longer works." },
    ...instanceAdminErrors,
    404: describeErrorResponse("No token with this ID exists."),
  },
});

export const importDirectoryRoute = createRoute({
  method: "post",
  path: "/v1/directory/imports",
  summary:
    "Create, update and deactivate users and their Company groups from a JSON or CSV file. " +
    "All rows apply or none does. Roles cannot be imported. Takes an Instance admin.",
  description: "A CSV file (`text/csv`) has the columns `email`, `displayName`, and optionally " +
    "`companyGroups`, separated by `|`, and `active`. Commas or semicolons separate the columns.",
  tags: DIRECTORY_TAGS,
  security: accessTokenSecurity,
  request: {
    body: {
      content: {
        "application/json": { schema: directoryImportRequestSchema },
        "text/csv": { schema: z.string() },
      },
      // Marked optional so that only a JSON body goes through the JSON validator; the handler
      // refuses a request without either body.
      required: false,
    },
  },
  responses: {
    200: {
      description: "What the file changed.",
      content: { "application/json": { schema: directoryImportSummarySchema } },
    },
    400: {
      description: "The file has invalid rows, and nothing from it was applied.",
      content: { "application/json": { schema: directoryImportFailureSchema } },
    },
    ...instanceAdminErrors,
  },
});

/** Where a directory is pointed: its SCIM tenant URL is the Instance's address plus this path. */
export const SCIM_BASE_PATH = "/scim/v2";

const SCIM_TAGS = ["SCIM 2.0"];
const directoryTokenSecurity = [{ [DIRECTORY_TOKEN_SECURITY_SCHEME_NAME]: [] }];
const resourcePathParameters = z.object({ resourceId: z.string() });

/**
 * The request and response bodies are the SCIM resources of RFC 7643 as `application/scim+json`.
 * Declaring no body here keeps a malformed one away from the JSON validator, because SCIM has its
 * own error format.
 */
function createScimRoute<Method extends "get" | "post" | "put" | "patch" | "delete">(
  method: Method,
  resourcePath: string,
  summary: string,
) {
  return createRoute({
    method,
    path: `${SCIM_BASE_PATH}${resourcePath}`,
    summary,
    tags: SCIM_TAGS,
    security: directoryTokenSecurity,
    responses: {
      200: { description: "A SCIM resource or list, as RFC 7644 defines." },
      201: { description: "The created SCIM resource." },
      204: { description: "The resource is gone." },
      400: { description: "A SCIM error: the request is invalid." },
      401: { description: "A SCIM error: the directory token is missing, invalid or revoked." },
      404: { description: "A SCIM error: no such resource." },
      409: { description: "A SCIM error: the value is already taken." },
    },
  });
}

function createScimResourceRoute<Method extends "get" | "put" | "patch" | "delete">(
  method: Method,
  collectionPath: string,
  summary: string,
) {
  return {
    ...createScimRoute(method, `${collectionPath}/{resourceId}`, summary),
    request: { params: resourcePathParameters },
  };
}

export const getScimServiceProviderConfigRoute = createScimRoute(
  "get",
  "/ServiceProviderConfig",
  "Describe the SCIM features this Instance supports.",
);
export const listScimResourceTypesRoute = createScimRoute(
  "get",
  "/ResourceTypes",
  "List the SCIM resource types.",
);
export const listScimSchemasRoute = createScimRoute("get", "/Schemas", "List the SCIM schemas.");

export const listScimUsersRoute = createScimRoute(
  "get",
  "/Users",
  "List users from the directory. Filters: `userName`, `externalId` or `id` with `eq`.",
);
export const createScimUserRoute = createScimRoute("post", "/Users", "Create a user.");
export const getScimUserRoute = createScimResourceRoute("get", "/Users", "Get a user.");
export const replaceScimUserRoute = createScimResourceRoute("put", "/Users", "Replace a user.");
export const patchScimUserRoute = createScimResourceRoute("patch", "/Users", "Change a user.");
export const deleteScimUserRoute = createScimResourceRoute(
  "delete",
  "/Users",
  "Remove a user from the directory. Deactivates them and keeps their record.",
);

export const listScimGroupsRoute = createScimRoute(
  "get",
  "/Groups",
  "List Company groups. Filters: `displayName`, `externalId` or `id` with `eq`.",
);
export const createScimGroupRoute = createScimRoute("post", "/Groups", "Create a Company group.");
export const getScimGroupRoute = createScimResourceRoute("get", "/Groups", "Get a Company group.");
export const replaceScimGroupRoute = createScimResourceRoute(
  "put",
  "/Groups",
  "Replace a Company group.",
);
export const patchScimGroupRoute = createScimResourceRoute(
  "patch",
  "/Groups",
  "Change a Company group or its members.",
);
export const deleteScimGroupRoute = createScimResourceRoute(
  "delete",
  "/Groups",
  "Delete a Company group. Its members leave the Groups it was mapped to.",
);

/** Managing the sync, and the SCIM endpoints that the company's directory calls. */
export const directoryRoutes = [
  getDirectoryStatusRoute,
  createDirectoryTokenRoute,
  revokeDirectoryTokenRoute,
  importDirectoryRoute,
  getScimServiceProviderConfigRoute,
  listScimResourceTypesRoute,
  listScimSchemasRoute,
  listScimUsersRoute,
  createScimUserRoute,
  getScimUserRoute,
  replaceScimUserRoute,
  patchScimUserRoute,
  deleteScimUserRoute,
  listScimGroupsRoute,
  createScimGroupRoute,
  getScimGroupRoute,
  replaceScimGroupRoute,
  patchScimGroupRoute,
  deleteScimGroupRoute,
];
