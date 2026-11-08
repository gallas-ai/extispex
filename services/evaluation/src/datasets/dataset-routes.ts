import {
  createDatasetRoute,
  createErrorResponse,
  createTestCaseRoute,
  deleteDatasetRoute,
  deleteTestCaseRoute,
  getDatasetRoute,
  getTestCaseRoute,
  listDatasetsRoute,
  listTestCasesRoute,
  updateTestCaseRoute,
} from "@extispex/contracts";
import type { ProjectAccessEnvironment } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { DatasetRepository } from "../storage/dataset-repository.ts";

export interface DatasetRouteDependencies {
  datasetRepository: DatasetRepository;
  readCurrentTime: () => Date;
}

function datasetNotFoundError(datasetName: string) {
  return createErrorResponse("not_found", `Dataset ${datasetName} was not found.`);
}

function testCaseNotFoundError(datasetName: string, testCaseName: string) {
  return createErrorResponse(
    "not_found",
    `Dataset ${datasetName} has no Test Case ${testCaseName}.`,
  );
}

export function registerDatasetRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  { datasetRepository, readCurrentTime }: DatasetRouteDependencies,
): void {
  app.openapi(createDatasetRoute, async (context) => {
    const request = context.req.valid("json");
    const creation = await datasetRepository.createDataset(
      context.get("projectAccess").projectId,
      { name: request.name, description: request.description?.trim() ?? "" },
      readCurrentTime(),
    );
    if (creation.status === "name_taken") {
      return context.json(
        createErrorResponse("conflict", `A Dataset named ${request.name} already exists.`),
        409,
      );
    }
    return context.json(creation.created, 201);
  });

  app.openapi(listDatasetsRoute, async (context) => {
    const datasets = await datasetRepository.listDatasets(context.get("projectAccess").projectId);
    return context.json({ datasets }, 200);
  });

  app.openapi(getDatasetRoute, async (context) => {
    const { datasetName } = context.req.valid("param");
    const dataset = await datasetRepository.findDataset(
      context.get("projectAccess").projectId,
      datasetName,
    );
    if (dataset === null) return context.json(datasetNotFoundError(datasetName), 404);
    return context.json(await datasetRepository.readDataset(dataset), 200);
  });

  app.openapi(deleteDatasetRoute, async (context) => {
    const { datasetName } = context.req.valid("param");
    const dataset = await datasetRepository.findDataset(
      context.get("projectAccess").projectId,
      datasetName,
    );
    if (dataset === null) return context.json(datasetNotFoundError(datasetName), 404);
    await datasetRepository.deleteDataset(dataset);
    return context.body(null, 204);
  });

  app.openapi(createTestCaseRoute, async (context) => {
    const { datasetName } = context.req.valid("param");
    const { name, ...definition } = context.req.valid("json");
    const dataset = await datasetRepository.findDataset(
      context.get("projectAccess").projectId,
      datasetName,
    );
    if (dataset === null) return context.json(datasetNotFoundError(datasetName), 404);
    const creation = await datasetRepository.createTestCase(
      dataset,
      { name, definition },
      readCurrentTime(),
    );
    if (creation.status === "name_taken") {
      return context.json(
        createErrorResponse("conflict", `A Test Case named ${name} already exists.`),
        409,
      );
    }
    return context.json(creation.created, 201);
  });

  app.openapi(listTestCasesRoute, async (context) => {
    const { datasetName } = context.req.valid("param");
    const dataset = await datasetRepository.findDataset(
      context.get("projectAccess").projectId,
      datasetName,
    );
    if (dataset === null) return context.json(datasetNotFoundError(datasetName), 404);
    return context.json({ testCases: await datasetRepository.listTestCases(dataset) }, 200);
  });

  app.openapi(getTestCaseRoute, async (context) => {
    const { datasetName, testCaseName } = context.req.valid("param");
    const dataset = await datasetRepository.findDataset(
      context.get("projectAccess").projectId,
      datasetName,
    );
    if (dataset === null) return context.json(datasetNotFoundError(datasetName), 404);
    const testCase = await datasetRepository.findTestCase(dataset, testCaseName);
    if (testCase === null) {
      return context.json(testCaseNotFoundError(datasetName, testCaseName), 404);
    }
    return context.json(testCase, 200);
  });

  app.openapi(updateTestCaseRoute, async (context) => {
    const { datasetName, testCaseName } = context.req.valid("param");
    const dataset = await datasetRepository.findDataset(
      context.get("projectAccess").projectId,
      datasetName,
    );
    if (dataset === null) return context.json(datasetNotFoundError(datasetName), 404);
    const testCase = await datasetRepository.updateTestCase(
      dataset,
      testCaseName,
      context.req.valid("json"),
      readCurrentTime(),
    );
    if (testCase === null) {
      return context.json(testCaseNotFoundError(datasetName, testCaseName), 404);
    }
    return context.json(testCase, 200);
  });

  app.openapi(deleteTestCaseRoute, async (context) => {
    const { datasetName, testCaseName } = context.req.valid("param");
    const dataset = await datasetRepository.findDataset(
      context.get("projectAccess").projectId,
      datasetName,
    );
    if (dataset === null) return context.json(datasetNotFoundError(datasetName), 404);
    if (!await datasetRepository.deleteTestCase(dataset, testCaseName, readCurrentTime())) {
      return context.json(testCaseNotFoundError(datasetName, testCaseName), 404);
    }
    return context.body(null, 204);
  });
}
