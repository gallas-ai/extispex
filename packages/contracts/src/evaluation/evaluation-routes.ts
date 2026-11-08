import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import {
  commonErrorResponses,
  describeErrorResponse,
  projectDataSecurity,
} from "../openapi-route-parts.ts";
import {
  createDatasetRequestSchema,
  createEvaluationRunRequestSchema,
  createTestCaseRequestSchema,
  datasetNameSchema,
  datasetSchema,
  evaluationRunSummarySchema,
  evaluationRunWorkSchema,
  listDatasetsResponseSchema,
  listEvaluationRunsQuerySchema,
  listEvaluationRunsResponseSchema,
  listIterationResultsResponseSchema,
  listTestCaseResultsResponseSchema,
  listTestCasesResponseSchema,
  reportIterationsRequestSchema,
  reportIterationsResponseSchema,
  resultPageQuerySchema,
  testCaseDefinitionSchema,
  testCaseNameSchema,
  testCaseSchema,
} from "./evaluation-contracts.ts";

const DATASET_TAGS = ["Datasets"];
const RUN_TAGS = ["Evaluation Runs"];

const datasetPathParameters = z.object({ datasetName: datasetNameSchema });
const testCasePathParameters = datasetPathParameters.extend({ testCaseName: testCaseNameSchema });
const runPathParameters = z.object({ runId: z.string().min(1).max(64) });

function jsonBody<Schema extends z.ZodType>(schema: Schema) {
  return { content: { "application/json": { schema } }, required: true };
}

function jsonResponse<Schema extends z.ZodType>(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema } } };
}

const datasetNotFound = describeErrorResponse("No Dataset with this name exists in the Project.");
const testCaseNotFound = describeErrorResponse("The Dataset or the Test Case does not exist.");
const runNotFound = describeErrorResponse("No Evaluation Run with this ID exists in the Project.");

export const createDatasetRoute = createRoute({
  method: "post",
  path: "/v1/datasets",
  summary: "Create a Dataset.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  request: { body: jsonBody(createDatasetRequestSchema) },
  responses: {
    201: jsonResponse("The Dataset.", datasetSchema),
    ...commonErrorResponses,
    409: describeErrorResponse("A Dataset with this name already exists in the Project."),
  },
});

export const listDatasetsRoute = createRoute({
  method: "get",
  path: "/v1/datasets",
  summary: "List the Project's Datasets, most recently changed first.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  responses: {
    200: jsonResponse("The Datasets.", listDatasetsResponseSchema),
    ...commonErrorResponses,
  },
});

export const getDatasetRoute = createRoute({
  method: "get",
  path: "/v1/datasets/{datasetName}",
  summary: "Get a Dataset.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  request: { params: datasetPathParameters },
  responses: {
    200: jsonResponse("The Dataset.", datasetSchema),
    ...commonErrorResponses,
    404: datasetNotFound,
  },
});

export const deleteDatasetRoute = createRoute({
  method: "delete",
  path: "/v1/datasets/{datasetName}",
  summary: "Delete a Dataset and its Test Cases. Evaluation Runs keep their copies.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  request: { params: datasetPathParameters },
  responses: {
    204: { description: "The Dataset was deleted." },
    ...commonErrorResponses,
    404: datasetNotFound,
  },
});

export const createTestCaseRoute = createRoute({
  method: "post",
  path: "/v1/datasets/{datasetName}/test-cases",
  summary: "Add a Test Case to a Dataset.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  request: { params: datasetPathParameters, body: jsonBody(createTestCaseRequestSchema) },
  responses: {
    201: jsonResponse("The Test Case.", testCaseSchema),
    ...commonErrorResponses,
    404: datasetNotFound,
    409: describeErrorResponse("A Test Case with this name already exists in the Dataset."),
  },
});

export const listTestCasesRoute = createRoute({
  method: "get",
  path: "/v1/datasets/{datasetName}/test-cases",
  summary: "List a Dataset's Test Cases by name.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  request: { params: datasetPathParameters },
  responses: {
    200: jsonResponse("The Test Cases.", listTestCasesResponseSchema),
    ...commonErrorResponses,
    404: datasetNotFound,
  },
});

export const getTestCaseRoute = createRoute({
  method: "get",
  path: "/v1/datasets/{datasetName}/test-cases/{testCaseName}",
  summary: "Get a Test Case.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  request: { params: testCasePathParameters },
  responses: {
    200: jsonResponse("The Test Case.", testCaseSchema),
    ...commonErrorResponses,
    404: testCaseNotFound,
  },
});

export const updateTestCaseRoute = createRoute({
  method: "put",
  path: "/v1/datasets/{datasetName}/test-cases/{testCaseName}",
  summary: "Replace a Test Case. Evaluation Runs that have started keep their copies.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  request: { params: testCasePathParameters, body: jsonBody(testCaseDefinitionSchema) },
  responses: {
    200: jsonResponse("The Test Case.", testCaseSchema),
    ...commonErrorResponses,
    404: testCaseNotFound,
  },
});

export const deleteTestCaseRoute = createRoute({
  method: "delete",
  path: "/v1/datasets/{datasetName}/test-cases/{testCaseName}",
  summary: "Delete a Test Case. Evaluation Runs that have started keep their copies.",
  tags: DATASET_TAGS,
  security: projectDataSecurity,
  request: { params: testCasePathParameters },
  responses: {
    204: { description: "The Test Case was deleted." },
    ...commonErrorResponses,
    404: testCaseNotFound,
  },
});

export const createEvaluationRunRoute = createRoute({
  method: "post",
  path: "/v1/evaluation-runs",
  summary: "Start an Evaluation Run of a Dataset and get its first Iterations.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { body: jsonBody(createEvaluationRunRequestSchema) },
  responses: {
    201: jsonResponse("The run and its first Iterations.", evaluationRunWorkSchema),
    ...commonErrorResponses,
    404: datasetNotFound,
    409: describeErrorResponse("The Dataset has no Test Cases."),
  },
});

export const listEvaluationRunsRoute = createRoute({
  method: "get",
  path: "/v1/evaluation-runs",
  summary: "List the Project's Evaluation Runs, newest first.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { query: listEvaluationRunsQuerySchema },
  responses: {
    200: jsonResponse("The Evaluation Runs.", listEvaluationRunsResponseSchema),
    ...commonErrorResponses,
  },
});

export const getEvaluationRunRoute = createRoute({
  method: "get",
  path: "/v1/evaluation-runs/{runId}",
  summary: "Get an Evaluation Run's state and verdict.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { params: runPathParameters },
  responses: {
    200: jsonResponse("The Evaluation Run.", evaluationRunSummarySchema),
    ...commonErrorResponses,
    404: runNotFound,
  },
});

export const listTestCaseResultsRoute = createRoute({
  method: "get",
  path: "/v1/evaluation-runs/{runId}/test-cases",
  summary: "List a page of a run's Test Case results, in the order the run executes them.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { params: runPathParameters, query: resultPageQuerySchema },
  responses: {
    200: jsonResponse("A page of Test Case results.", listTestCaseResultsResponseSchema),
    ...commonErrorResponses,
    404: runNotFound,
  },
});

export const listIterationResultsRoute = createRoute({
  method: "get",
  path: "/v1/evaluation-runs/{runId}/test-cases/{testCaseName}/iterations",
  summary: "List a page of one Test Case's Iterations in a run, with every attempt.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: {
    params: runPathParameters.extend({ testCaseName: testCaseNameSchema }),
    query: resultPageQuerySchema,
  },
  responses: {
    200: jsonResponse("A page of Iteration results.", listIterationResultsResponseSchema),
    ...commonErrorResponses,
    404: describeErrorResponse("The run does not exist or has no such Test Case."),
  },
});

export const getEvaluationRunWorkRoute = createRoute({
  method: "get",
  path: "/v1/evaluation-runs/{runId}/work",
  summary: "Get the Iterations a script should run next, and the run's verdict once it has one.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { params: runPathParameters },
  responses: {
    200: jsonResponse("The next Iterations and the run's state.", evaluationRunWorkSchema),
    ...commonErrorResponses,
    404: runNotFound,
  },
});

export const reportIterationsRoute = createRoute({
  method: "post",
  path: "/v1/evaluation-runs/{runId}/reports",
  summary: "Report Outputs or errors of Iterations and get the next Iterations.",
  description: "Each report is handled on its own, and refused ones are listed in `rejected`. " +
    "Sending the same report again changes nothing, so a batch can be retried safely.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { params: runPathParameters, body: jsonBody(reportIterationsRequestSchema) },
  responses: {
    200: jsonResponse(
      "The next Iterations and any refused reports.",
      reportIterationsResponseSchema,
    ),
    ...commonErrorResponses,
    404: runNotFound,
  },
});

export const finishEvaluationRunRoute = createRoute({
  method: "post",
  path: "/v1/evaluation-runs/{runId}/finish",
  summary: "End a run early. Iterations that were not reported end as Error.",
  description: "A run ends by itself once every Iteration has a result, so this is only needed " +
    "to stop early. The status stays `running` until the worker has judged what was reported.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { params: runPathParameters },
  responses: {
    200: jsonResponse("The run's state.", evaluationRunWorkSchema),
    ...commonErrorResponses,
    404: runNotFound,
  },
});

export const evaluationPublicRoutes: RouteConfig[] = [
  createDatasetRoute,
  listDatasetsRoute,
  getDatasetRoute,
  deleteDatasetRoute,
  createTestCaseRoute,
  listTestCasesRoute,
  getTestCaseRoute,
  updateTestCaseRoute,
  deleteTestCaseRoute,
  createEvaluationRunRoute,
  listEvaluationRunsRoute,
  getEvaluationRunRoute,
  listTestCaseResultsRoute,
  listIterationResultsRoute,
  getEvaluationRunWorkRoute,
  reportIterationsRoute,
  finishEvaluationRunRoute,
];
