import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  apiKeySecurity,
  commonErrorResponses,
  describeErrorResponse,
} from "../openapi-route-parts.ts";
import {
  comparePromptVersionsQuerySchema,
  createPromptRequestSchema,
  createPromptVersionRequestSchema,
  listPromptsResponseSchema,
  listPromptVersionsResponseSchema,
  movePromptLabelRequestSchema,
  promptLabelNameSchema,
  promptLabelSchema,
  promptNameSchema,
  promptSummarySchema,
  promptVersionComparisonSchema,
  promptVersionSchema,
} from "./prompt-contracts.ts";

const TAGS = ["Prompts"];

const promptPathParameters = z.object({ promptName: promptNameSchema });
const versionPathParameters = promptPathParameters.extend({
  versionNumber: z.coerce.number().int().min(1),
});
const labelPathParameters = promptPathParameters.extend({ labelName: promptLabelNameSchema });

function jsonBody<Schema extends z.ZodType>(schema: Schema) {
  return { content: { "application/json": { schema } }, required: true };
}

function jsonResponse<Schema extends z.ZodType>(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema } } };
}

const promptNotFound = describeErrorResponse("No prompt with this name exists in the Project.");

export const createPromptRoute = createRoute({
  method: "post",
  path: "/v1/prompts",
  summary: "Create a prompt with its first version.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { body: jsonBody(createPromptRequestSchema) },
  responses: {
    201: jsonResponse("The prompt's first version.", promptVersionSchema),
    ...commonErrorResponses,
    409: describeErrorResponse("A prompt with this name already exists in the Project."),
  },
});

export const listPromptsRoute = createRoute({
  method: "get",
  path: "/v1/prompts",
  summary: "List the Project's prompts, most recently changed first.",
  tags: TAGS,
  security: apiKeySecurity,
  responses: {
    200: jsonResponse("The prompts.", listPromptsResponseSchema),
    ...commonErrorResponses,
  },
});

export const getPromptRoute = createRoute({
  method: "get",
  path: "/v1/prompts/{promptName}",
  summary: "Get a prompt with its latest version number and Prompt Labels.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { params: promptPathParameters },
  responses: {
    200: jsonResponse("The prompt.", promptSummarySchema),
    ...commonErrorResponses,
    404: promptNotFound,
  },
});

export const createPromptVersionRoute = createRoute({
  method: "post",
  path: "/v1/prompts/{promptName}/versions",
  summary: "Add a Prompt Version. It gets the next number and never changes afterwards.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { params: promptPathParameters, body: jsonBody(createPromptVersionRequestSchema) },
  responses: {
    201: jsonResponse("The new version.", promptVersionSchema),
    ...commonErrorResponses,
    404: promptNotFound,
  },
});

export const listPromptVersionsRoute = createRoute({
  method: "get",
  path: "/v1/prompts/{promptName}/versions",
  summary: "List a prompt's versions, newest first.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { params: promptPathParameters },
  responses: {
    200: jsonResponse("The versions, without their text.", listPromptVersionsResponseSchema),
    ...commonErrorResponses,
    404: promptNotFound,
  },
});

export const getPromptVersionRoute = createRoute({
  method: "get",
  path: "/v1/prompts/{promptName}/versions/{versionNumber}",
  summary: "Get a Prompt Version by its number.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { params: versionPathParameters },
  responses: {
    200: jsonResponse("The version.", promptVersionSchema),
    ...commonErrorResponses,
    404: describeErrorResponse("The prompt or the version does not exist."),
  },
});

export const getPromptVersionByLabelRoute = createRoute({
  method: "get",
  path: "/v1/prompts/{promptName}/labels/{labelName}",
  summary: "Get the Prompt Version that a Prompt Label points to.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { params: labelPathParameters },
  responses: {
    200: jsonResponse("The version the label points to.", promptVersionSchema),
    ...commonErrorResponses,
    404: describeErrorResponse("The prompt or the label does not exist."),
  },
});

export const movePromptLabelRoute = createRoute({
  method: "put",
  path: "/v1/prompts/{promptName}/labels/{labelName}",
  summary: "Point a Prompt Label at a version, creating the label if it does not exist.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { params: labelPathParameters, body: jsonBody(movePromptLabelRequestSchema) },
  responses: {
    200: jsonResponse("The label.", promptLabelSchema),
    ...commonErrorResponses,
    404: describeErrorResponse("The prompt or the version does not exist."),
  },
});

export const removePromptLabelRoute = createRoute({
  method: "delete",
  path: "/v1/prompts/{promptName}/labels/{labelName}",
  summary: "Remove a Prompt Label. The version it pointed to stays.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { params: labelPathParameters },
  responses: {
    204: { description: "The label was removed." },
    ...commonErrorResponses,
    404: describeErrorResponse("The prompt or the label does not exist."),
  },
});

export const comparePromptVersionsRoute = createRoute({
  method: "get",
  path: "/v1/prompts/{promptName}/compare",
  summary: "Compare two Prompt Versions by text and model parameters.",
  tags: TAGS,
  security: apiKeySecurity,
  request: { params: promptPathParameters, query: comparePromptVersionsQuerySchema },
  responses: {
    200: jsonResponse(
      "Both versions and what changed between them.",
      promptVersionComparisonSchema,
    ),
    ...commonErrorResponses,
    404: describeErrorResponse("The prompt or one of the versions does not exist."),
  },
});

/** The Prompt service's endpoints, all reachable through the Gateway. */
export const promptPublicRoutes = [
  createPromptRoute,
  listPromptsRoute,
  getPromptRoute,
  createPromptVersionRoute,
  listPromptVersionsRoute,
  getPromptVersionRoute,
  getPromptVersionByLabelRoute,
  movePromptLabelRoute,
  removePromptLabelRoute,
  comparePromptVersionsRoute,
];
