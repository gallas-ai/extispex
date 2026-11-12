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
  createTargetRequestSchema,
  createTestCaseRequestSchema,
  datasetNameSchema,
  datasetSchema,
  evaluationRunSchema,
  evaluationRunWorkSchema,
  listDatasetsResponseSchema,
  listEvaluationRunsQuerySchema,
  listEvaluationRunsResponseSchema,
  listIterationResultsResponseSchema,
  listTargetsResponseSchema,
  listTestCaseResultsResponseSchema,
  listTestCasesResponseSchema,
  reportIterationsRequestSchema,
  reportIterationsResponseSchema,
  resultPageQuerySchema,
  targetNameSchema,
  targetSchema,
  testCaseDefinitionSchema,
  testCaseNameSchema,
  testCaseResultSchema,
  testCaseSchema,
  updateTargetRequestSchema,
} from "./evaluation-contracts.ts";
import {
  listReportDeliveriesResponseSchema,
  reportSettingsSchema,
  updateReportSettingsRequestSchema,
} from "./report-contracts.ts";
  createLlmProviderRequestSchema,
  listLlmProvidersResponseSchema,
  llmProviderNameSchema,
  llmProviderSchema,
  llmSummarySettingsSchema,
  updateLlmProviderRequestSchema,
  updateLlmSummarySettingsRequestSchema,
} from "./llm-provider-contracts.ts";

const DATASET_TAGS = ["Datasets"];
const RUN_TAGS = ["Evaluation Runs"];
const TARGET_TAGS = ["Targets"];
const REPORT_TAGS = ["Reports"];
const LLM_PROVIDER_TAGS = ["LLM providers"];

const datasetPathParameters = z.object({ datasetName: datasetNameSchema });
const testCasePathParameters = datasetPathParameters.extend({ testCaseName: testCaseNameSchema });
const runPathParameters = z.object({ runId: z.string().min(1).max(64) });
const targetPathParameters = z.object({ targetName: targetNameSchema });
const llmProviderPathParameters = z.object({ providerName: llmProviderNameSchema });

function jsonBody<Schema extends z.ZodType>(schema: Schema) {
  return { content: { "application/json": { schema } }, required: true };
}

function jsonResponse<Schema extends z.ZodType>(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema } } };
}

const datasetNotFound = describeErrorResponse("No Dataset with this name exists in the Project.");
const testCaseNotFound = describeErrorResponse("The Dataset or the Test Case does not exist.");
const runNotFound = describeErrorResponse("No Evaluation Run with this ID exists in the Project.");
const targetNotFound = describeErrorResponse("No Target with this name exists in the Project.");
const llmProviderNotFound = describeErrorResponse(
  "No LLM provider with this name exists in the Project.",
);

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
    404: describeErrorResponse("The Dataset or the Target does not exist in the Project."),
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
    200: jsonResponse("The Evaluation Run with its LLM Summary.", evaluationRunSchema),
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

export const getTestCaseResultRoute = createRoute({
  method: "get",
  path: "/v1/evaluation-runs/{runId}/test-cases/{testCaseName}",
  summary: "Get one Test Case's result in a run.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { params: runPathParameters.extend({ testCaseName: testCaseNameSchema }) },
  responses: {
    200: jsonResponse("The Test Case result.", testCaseResultSchema),
    ...commonErrorResponses,
    404: describeErrorResponse("The run does not exist or has no such Test Case."),
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

export const createTargetRoute = createRoute({
  method: "post",
  path: "/v1/targets",
  summary: "Create a Target that Server-Driven Execution can call.",
  tags: TARGET_TAGS,
  security: projectDataSecurity,
  request: { body: jsonBody(createTargetRequestSchema) },
  responses: {
    201: jsonResponse("The Target, without its credential.", targetSchema),
    ...commonErrorResponses,
    409: describeErrorResponse("A Target with this name already exists in the Project."),
  },
});

export const listTargetsRoute = createRoute({
  method: "get",
  path: "/v1/targets",
  summary: "List the Project's Targets by name.",
  tags: TARGET_TAGS,
  security: projectDataSecurity,
  responses: {
    200: jsonResponse("The Targets, without their credentials.", listTargetsResponseSchema),
    ...commonErrorResponses,
  },
});

export const getTargetRoute = createRoute({
  method: "get",
  path: "/v1/targets/{targetName}",
  summary: "Get a Target, without its credential.",
  tags: TARGET_TAGS,
  security: projectDataSecurity,
  request: { params: targetPathParameters },
  responses: {
    200: jsonResponse("The Target.", targetSchema),
    ...commonErrorResponses,
    404: targetNotFound,
  },
});

export const updateTargetRoute = createRoute({
  method: "put",
  path: "/v1/targets/{targetName}",
  summary: "Change a Target. A running Evaluation Run uses the change from its next call.",
  tags: TARGET_TAGS,
  security: projectDataSecurity,
  request: { params: targetPathParameters, body: jsonBody(updateTargetRequestSchema) },
  responses: {
    200: jsonResponse("The Target, without its credential.", targetSchema),
    ...commonErrorResponses,
    404: targetNotFound,
  },
});

export const deleteTargetRoute = createRoute({
  method: "delete",
  path: "/v1/targets/{targetName}",
  summary: "Delete a Target and its credential. Finished Evaluation Runs keep its name.",
  tags: TARGET_TAGS,
  security: projectDataSecurity,
  request: { params: targetPathParameters },
  responses: {
    204: { description: "The Target was deleted." },
    ...commonErrorResponses,
    404: targetNotFound,
  },
});

export const listReportDeliveriesRoute = createRoute({
  method: "get",
  path: "/v1/evaluation-runs/{runId}/report-deliveries",
  summary: "List where the run's Report went and how each delivery is doing.",
  description: "A run gets a delivery for each channel when it finishes, if the Project's " +
    "Report settings ask for one. A delivery never changes the run's result.",
  tags: RUN_TAGS,
  security: projectDataSecurity,
  request: { params: runPathParameters },
  responses: {
    200: jsonResponse("The run's Report deliveries.", listReportDeliveriesResponseSchema),
    ...commonErrorResponses,
    404: runNotFound,
  },
});

export const getReportSettingsRoute = createRoute({
  method: "get",
  path: "/v1/report-settings",
  summary: "Get the Project's Report settings, without their secrets.",
  tags: REPORT_TAGS,
  security: projectDataSecurity,
  responses: {
    200: jsonResponse("The Report settings.", reportSettingsSchema),
    ...commonErrorResponses,
  },
});

export const createLlmProviderRoute = createRoute({
  method: "post",
  path: "/v1/llm-providers",
  summary: "Add an LLM provider for Grading Evaluators and LLM Summaries.",
  tags: LLM_PROVIDER_TAGS,
  security: projectDataSecurity,
  request: { body: jsonBody(createLlmProviderRequestSchema) },
  responses: {
    201: jsonResponse("The LLM provider, without its API key.", llmProviderSchema),
    ...commonErrorResponses,
    409: describeErrorResponse("An LLM provider with this name already exists in the Project."),
  },
});

export const listLlmProvidersRoute = createRoute({
  method: "get",
  path: "/v1/llm-providers",
  summary: "List the Project's LLM providers by name, with their capabilities.",
  tags: LLM_PROVIDER_TAGS,
  security: projectDataSecurity,
  responses: {
    200: jsonResponse("The LLM providers, without their API keys.", listLlmProvidersResponseSchema),
    ...commonErrorResponses,
  },
});

export const updateReportSettingsRoute = createRoute({
  method: "put",
  path: "/v1/report-settings",
  summary: "Replace the Project's Report settings. Runs that finish afterwards use them.",
  description: "The SMTP password and the Teams webhook URL are stored encrypted. Leaving one " +
    "out keeps the stored value.",
  tags: REPORT_TAGS,
  security: projectDataSecurity,
  request: { body: jsonBody(updateReportSettingsRequestSchema) },
  responses: {
    200: jsonResponse("The Report settings, without their secrets.", reportSettingsSchema),
    ...commonErrorResponses,
  },
});

export const getLlmProviderRoute = createRoute({
  method: "get",
  path: "/v1/llm-providers/{providerName}",
  summary: "Get an LLM provider, without its API key.",
  tags: LLM_PROVIDER_TAGS,
  security: projectDataSecurity,
  request: { params: llmProviderPathParameters },
  responses: {
    200: jsonResponse("The LLM provider.", llmProviderSchema),
    ...commonErrorResponses,
    404: llmProviderNotFound,
  },
});

export const updateLlmProviderRoute = createRoute({
  method: "put",
  path: "/v1/llm-providers/{providerName}",
  summary: "Change an LLM provider. Its kind and name stay as they are.",
  tags: LLM_PROVIDER_TAGS,
  security: projectDataSecurity,
  request: { params: llmProviderPathParameters, body: jsonBody(updateLlmProviderRequestSchema) },
  responses: {
    200: jsonResponse("The LLM provider, without its API key.", llmProviderSchema),
    ...commonErrorResponses,
    404: llmProviderNotFound,
  },
});

export const deleteLlmProviderRoute = createRoute({
  method: "delete",
  path: "/v1/llm-providers/{providerName}",
  summary: "Delete an LLM provider and its API key. Grading Evaluators using it end as Error.",
  tags: LLM_PROVIDER_TAGS,
  security: projectDataSecurity,
  request: { params: llmProviderPathParameters },
  responses: {
    204: { description: "The LLM provider was deleted." },
    ...commonErrorResponses,
    404: llmProviderNotFound,
  },
});

export const getLlmSummarySettingsRoute = createRoute({
  method: "get",
  path: "/v1/llm-summary-settings",
  summary: "Get which LLM provider and prompt write the Project's LLM Summaries.",
  tags: LLM_PROVIDER_TAGS,
  security: projectDataSecurity,
  responses: {
    200: jsonResponse("The LLM Summary settings.", llmSummarySettingsSchema),
    ...commonErrorResponses,
  },
});

export const updateLlmSummarySettingsRoute = createRoute({
  method: "put",
  path: "/v1/llm-summary-settings",
  summary: "Choose the LLM provider and prompt for LLM Summaries of runs that finish from now on.",
  description:
    "The provider needs Text Generation. Without a prompt, the default prompt is used; " +
    "with `providerName: null`, runs get no LLM Summary.",
  tags: LLM_PROVIDER_TAGS,
  security: projectDataSecurity,
  request: { body: jsonBody(updateLlmSummarySettingsRequestSchema) },
  responses: {
    200: jsonResponse("The LLM Summary settings.", llmSummarySettingsSchema),
    ...commonErrorResponses,
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
  getTestCaseResultRoute,
  listIterationResultsRoute,
  getEvaluationRunWorkRoute,
  reportIterationsRoute,
  finishEvaluationRunRoute,
  listReportDeliveriesRoute,
  createTargetRoute,
  listTargetsRoute,
  getTargetRoute,
  updateTargetRoute,
  deleteTargetRoute,
  getReportSettingsRoute,
  updateReportSettingsRoute,
  createLlmProviderRoute,
  listLlmProvidersRoute,
  getLlmProviderRoute,
  updateLlmProviderRoute,
  deleteLlmProviderRoute,
  getLlmSummarySettingsRoute,
  updateLlmSummarySettingsRoute,
];
