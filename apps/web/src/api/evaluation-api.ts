import type {
  CreateDatasetRequest,
  CreateEvaluationRunRequest,
  CreateTargetRequest,
  CreateTestCaseRequest,
  Dataset,
  EvaluationRunSummary,
  EvaluationRunWork,
  ListDatasetsResponse,
  ListEvaluationRunsResponse,
  ListIterationResultsResponse,
  ListTargetsResponse,
  ListTestCaseResultsResponse,
  ListTestCasesResponse,
  Target,
  TestCase,
  TestCaseDefinitionInput,
  UpdateTargetRequest,
} from "@extispex/contracts";
import { type ApiCredentials, requestJson } from "./api-request.ts";

function datasetPath(datasetName: string): string {
  return `/v1/datasets/${encodeURIComponent(datasetName)}`;
}

function testCasePath(datasetName: string, testCaseName: string): string {
  return `${datasetPath(datasetName)}/test-cases/${encodeURIComponent(testCaseName)}`;
}

export function listDatasets(credentials: ApiCredentials): Promise<ListDatasetsResponse> {
  return requestJson(credentials, "/v1/datasets");
}

export function getDataset(credentials: ApiCredentials, datasetName: string): Promise<Dataset> {
  return requestJson(credentials, datasetPath(datasetName));
}

export function createDataset(
  credentials: ApiCredentials,
  request: CreateDatasetRequest,
): Promise<Dataset> {
  return requestJson(credentials, "/v1/datasets", { method: "POST", body: request });
}

export function deleteDataset(credentials: ApiCredentials, datasetName: string): Promise<null> {
  return requestJson(credentials, datasetPath(datasetName), { method: "DELETE" });
}

export function listTestCases(
  credentials: ApiCredentials,
  datasetName: string,
): Promise<ListTestCasesResponse> {
  return requestJson(credentials, `${datasetPath(datasetName)}/test-cases`);
}

export function getTestCase(
  credentials: ApiCredentials,
  datasetName: string,
  testCaseName: string,
): Promise<TestCase> {
  return requestJson(credentials, testCasePath(datasetName, testCaseName));
}

export function createTestCase(
  credentials: ApiCredentials,
  datasetName: string,
  request: CreateTestCaseRequest,
): Promise<TestCase> {
  return requestJson(credentials, `${datasetPath(datasetName)}/test-cases`, {
    method: "POST",
    body: request,
  });
}

export function updateTestCase(
  credentials: ApiCredentials,
  datasetName: string,
  testCaseName: string,
  definition: TestCaseDefinitionInput,
): Promise<TestCase> {
  return requestJson(credentials, testCasePath(datasetName, testCaseName), {
    method: "PUT",
    body: definition,
  });
}

export function deleteTestCase(
  credentials: ApiCredentials,
  datasetName: string,
  testCaseName: string,
): Promise<null> {
  return requestJson(credentials, testCasePath(datasetName, testCaseName), { method: "DELETE" });
}

export function listEvaluationRuns(
  credentials: ApiCredentials,
): Promise<ListEvaluationRunsResponse> {
  return requestJson(credentials, "/v1/evaluation-runs");
}

export function getEvaluationRun(
  credentials: ApiCredentials,
  runId: string,
): Promise<EvaluationRunSummary> {
  return requestJson(credentials, evaluationRunPath(runId));
}

function evaluationRunPath(runId: string): string {
  return `/v1/evaluation-runs/${encodeURIComponent(runId)}`;
}

function pageQuery(cursor: number | null): string {
  return cursor === null ? "" : `?cursor=${cursor}`;
}

export function listTestCaseResults(
  credentials: ApiCredentials,
  runId: string,
  cursor: number | null,
): Promise<ListTestCaseResultsResponse> {
  return requestJson(credentials, `${evaluationRunPath(runId)}/test-cases${pageQuery(cursor)}`);
}

export function listIterationResults(
  credentials: ApiCredentials,
  runId: string,
  testCaseName: string,
  cursor: number | null,
): Promise<ListIterationResultsResponse> {
  const testCasePath = `test-cases/${encodeURIComponent(testCaseName)}`;
  return requestJson(
    credentials,
    `${evaluationRunPath(runId)}/${testCasePath}/iterations${pageQuery(cursor)}`,
  );
}

export function createEvaluationRun(
  credentials: ApiCredentials,
  request: CreateEvaluationRunRequest,
): Promise<EvaluationRunWork> {
  return requestJson(credentials, "/v1/evaluation-runs", { method: "POST", body: request });
}

function targetPath(targetName: string): string {
  return `/v1/targets/${encodeURIComponent(targetName)}`;
}

export function listTargets(credentials: ApiCredentials): Promise<ListTargetsResponse> {
  return requestJson(credentials, "/v1/targets");
}

export function getTarget(credentials: ApiCredentials, targetName: string): Promise<Target> {
  return requestJson(credentials, targetPath(targetName));
}

export function createTarget(
  credentials: ApiCredentials,
  request: CreateTargetRequest,
): Promise<Target> {
  return requestJson(credentials, "/v1/targets", { method: "POST", body: request });
}

export function updateTarget(
  credentials: ApiCredentials,
  targetName: string,
  request: UpdateTargetRequest,
): Promise<Target> {
  return requestJson(credentials, targetPath(targetName), { method: "PUT", body: request });
}

export function deleteTarget(credentials: ApiCredentials, targetName: string): Promise<null> {
  return requestJson(credentials, targetPath(targetName), { method: "DELETE" });
}
