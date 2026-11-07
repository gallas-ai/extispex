import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { describeErrorResponse, instanceAdminKeySecurity } from "../openapi-route-parts.ts";
import {
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
  401: describeErrorResponse("The Instance admin key is missing or invalid."),
};

const projectNotFound = describeErrorResponse("No Project with this ID exists, or it is deleted.");

export const createProjectRoute = createRoute({
  method: "post",
  path: "/v1/projects",
  summary: "Create a Project.",
  tags: TAGS,
  security: instanceAdminKeySecurity,
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
  summary: "List the Instance's Projects by name. Deleted Projects are left out.",
  tags: TAGS,
  security: instanceAdminKeySecurity,
  responses: {
    200: jsonResponse("The Projects.", listProjectsResponseSchema),
    ...adminErrorResponses,
  },
});

export const getProjectRoute = createRoute({
  method: "get",
  path: "/v1/projects/{projectId}",
  summary: "Get a Project.",
  tags: TAGS,
  security: instanceAdminKeySecurity,
  request: { params: projectPathParameters },
  responses: {
    200: jsonResponse("The Project.", projectSchema),
    ...adminErrorResponses,
    404: projectNotFound,
  },
});

export const deleteProjectRoute = createRoute({
  method: "delete",
  path: "/v1/projects/{projectId}",
  summary: "Delete a Project. Its API keys stop working within a minute.",
  tags: TAGS,
  security: instanceAdminKeySecurity,
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
  summary: "Create a Project API key. The response is the only time the key is shown.",
  tags: TAGS,
  security: instanceAdminKeySecurity,
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
  summary: "List a Project's API keys, newest first, including revoked ones.",
  tags: TAGS,
  security: instanceAdminKeySecurity,
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
  summary: "Revoke an API key. It stops working within a minute and stays listed as revoked.",
  tags: TAGS,
  security: instanceAdminKeySecurity,
  request: { params: apiKeyPathParameters },
  responses: {
    204: { description: "The key is revoked, now or earlier." },
    ...adminErrorResponses,
    404: describeErrorResponse("The Project or the key does not exist."),
  },
});

/** The Identity service's endpoints, all reachable through the Gateway. */
export const identityPublicRoutes = [
  createProjectRoute,
  listProjectsRoute,
  getProjectRoute,
  deleteProjectRoute,
  createApiKeyRoute,
  listApiKeysRoute,
  revokeApiKeyRoute,
];
