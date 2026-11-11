import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { accessTokenSecurity, describeErrorResponse } from "../openapi-route-parts.ts";
import { accessRoutes } from "./access-routes.ts";
import { directoryRoutes } from "./directory-routes.ts";
import {
  accessibleProjectSchema,
  createApiKeyRequestSchema,
  createdApiKeySchema,
  createProjectRequestSchema,
  listApiKeysResponseSchema,
  listProjectsResponseSchema,
  projectSchema,
} from "./project-contracts.ts";

const TAGS = ["Projects"];

const projectPathParameters = z.object({ projectId: z.string().min(1).max(64) });
const apiKeyPathParameters = projectPathParameters.extend({
  apiKeyId: z.string().min(1).max(64),
});

function jsonBody<Schema extends z.ZodType>(schema: Schema) {
  return { content: { "application/json": { schema } }, required: true };
}

function jsonResponse<Schema extends z.ZodType>(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema } } };
}

const adminErrorResponses = {
  400: describeErrorResponse("The request is invalid."),
  401: describeErrorResponse("The access token is missing, invalid or not a user's."),
  403: describeErrorResponse("The user is not allowed to do this."),
};

const projectNotFound = describeErrorResponse("No Project with this ID exists, or it is deleted.");

export const createProjectRoute = createRoute({
  method: "post",
  path: "/v1/projects",
  summary: "Create a Project. Takes an Instance admin.",
  tags: TAGS,
  security: accessTokenSecurity,
  request: { body: jsonBody(createProjectRequestSchema) },
  responses: {
    201: jsonResponse("The new Project.", projectSchema),
    ...adminErrorResponses,
    409: describeErrorResponse("A Project with this name already exists."),
  },
});

export const listProjectsRoute = createRoute({
  method: "get",
  path: "/v1/projects",
  summary: "List the Projects the user has a Role in, or every Project for an Instance admin, " +
    "by name. Deleted Projects are left out.",
  tags: TAGS,
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse("The Projects with the user's Role in each.", listProjectsResponseSchema),
    ...adminErrorResponses,
  },
});

export const getProjectRoute = createRoute({
  method: "get",
  path: "/v1/projects/{projectId}",
  summary: "Get a Project in which the user has a Role, or any Project for an Instance admin.",
  tags: TAGS,
  security: accessTokenSecurity,
  request: { params: projectPathParameters },
  responses: {
    200: jsonResponse("The Project with the user's Role in it.", accessibleProjectSchema),
    ...adminErrorResponses,
    404: projectNotFound,
  },
});

export const deleteProjectRoute = createRoute({
  method: "delete",
  path: "/v1/projects/{projectId}",
  summary: "Delete a Project. Its API keys stop working within a minute. Takes an Instance admin.",
  tags: TAGS,
  security: accessTokenSecurity,
  request: { params: projectPathParameters },
  responses: {
    204: { description: "The Project is deleted." },
    ...adminErrorResponses,
    404: projectNotFound,
  },
});

export const createApiKeyRoute = createRoute({
  method: "post",
  path: "/v1/projects/{projectId}/api-keys",
  summary: "Create a Project API key, which acts as an `editor`. The response is the only time " +
    "the key is shown. Takes the Project's `admin` or an Instance admin.",
  tags: TAGS,
  security: accessTokenSecurity,
  request: { params: projectPathParameters, body: jsonBody(createApiKeyRequestSchema) },
  responses: {
    201: jsonResponse("The new key, including its secret value.", createdApiKeySchema),
    ...adminErrorResponses,
    404: projectNotFound,
  },
});

export const listApiKeysRoute = createRoute({
  method: "get",
  path: "/v1/projects/{projectId}/api-keys",
  summary: "List a Project's API keys, newest first, including revoked ones. Takes the " +
    "Project's `admin` or an Instance admin.",
  tags: TAGS,
  security: accessTokenSecurity,
  request: { params: projectPathParameters },
  responses: {
    200: jsonResponse("The keys, without their secret values.", listApiKeysResponseSchema),
    ...adminErrorResponses,
    404: projectNotFound,
  },
});

export const revokeApiKeyRoute = createRoute({
  method: "delete",
  path: "/v1/projects/{projectId}/api-keys/{apiKeyId}",
  summary: "Revoke an API key. It stops working within a minute and stays listed as revoked. " +
    "Takes the Project's `admin` or an Instance admin.",
  tags: TAGS,
  security: accessTokenSecurity,
  request: { params: apiKeyPathParameters },
  responses: {
    204: { description: "The key is revoked, now or earlier." },
    ...adminErrorResponses,
    404: describeErrorResponse("The Project or the key does not exist."),
  },
});

/** The Identity service's endpoints, all reachable through the Gateway. */
export const identityPublicRoutes = [
  ...accessRoutes,
  ...directoryRoutes,
  createProjectRoute,
  listProjectsRoute,
  getProjectRoute,
  deleteProjectRoute,
  createApiKeyRoute,
  listApiKeysRoute,
  revokeApiKeyRoute,
];
