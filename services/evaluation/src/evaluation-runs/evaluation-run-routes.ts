import {
  createErrorResponse,
  createEvaluationRunRoute,
  DEFAULT_BATCH_SIZE,
  finishEvaluationRunRoute,
  getEvaluationRunRoute,
  getEvaluationRunWorkRoute,
  getTestCaseResultRoute,
  listEvaluationRunsRoute,
  listIterationResultsRoute,
  listReportDeliveriesRoute,
  listTestCaseResultsRoute,
  reportIterationsRoute,
} from "@extispex/contracts";
import type { ProjectAccessEnvironment, StructuredLogger } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { EvaluationJob, JobQueue } from "../job-queue/mod.ts";
import type {
  DatasetRepository,
  EvaluationRunRepository,
  ReportDeliveryRepository,
  TargetRepository,
} from "../storage/mod.ts";

export interface EvaluationRunRouteDependencies {
  datasetRepository: DatasetRepository;
  evaluationRunRepository: EvaluationRunRepository;
  reportDeliveryRepository: ReportDeliveryRepository;
  targetRepository: TargetRepository;
  jobQueue: JobQueue;
  logger: StructuredLogger;
  readCurrentTime: () => Date;
}

function runNotFoundError(runId: string) {
  return createErrorResponse("not_found", `Evaluation Run ${runId} was not found.`);
}

export function registerEvaluationRunRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  dependencies: EvaluationRunRouteDependencies,
): void {
  const {
    datasetRepository,
    evaluationRunRepository,
    reportDeliveryRepository,
    targetRepository,
    jobQueue,
    logger,
    readCurrentTime,
  } = dependencies;

  /**
   * A failure here is not the script's problem: the worker queues stalled attempts and Report
   * deliveries again.
   */
  const enqueueAfterCommit = async (jobs: EvaluationJob[]) => {
    try {
      await jobQueue.enqueue(jobs);
    } catch (error) {
      logger.error("Reported attempts could not be queued yet", { error, jobCount: jobs.length });
    }
  };

  app.openapi(createEvaluationRunRoute, async (context) => {
    const request = context.req.valid("json");
    const { datasetName, executionMode } = request;
    const { projectId } = context.get("projectAccess");
    const dataset = await datasetRepository.findDataset(projectId, datasetName);
    if (dataset === null) {
      return context.json(
        createErrorResponse("not_found", `Dataset ${datasetName} was not found.`),
        404,
      );
    }
    const target = request.executionMode === "server"
      ? await targetRepository.findTarget(projectId, request.targetName)
      : null;
    if (request.executionMode === "server" && target === null) {
      return context.json(
        createErrorResponse("not_found", `Target ${request.targetName} was not found.`),
        404,
      );
    }
    const start = await evaluationRunRepository.startRun({
      projectId,
      datasetId: dataset.id,
      datasetName,
      executionMode,
      batchSize: request.executionMode === "client" ? request.batchSize : DEFAULT_BATCH_SIZE,
      target,
    }, readCurrentTime());
    if (start.status === "no_test_cases") {
      return context.json(
        createErrorResponse("conflict", `Dataset ${datasetName} has no Test Cases.`),
        409,
      );
    }
    await enqueueAfterCommit(start.jobs);
    return context.json((await evaluationRunRepository.readWork(projectId, start.runId))!, 201);
  });

  app.openapi(listEvaluationRunsRoute, async (context) => {
    const evaluationRuns = await evaluationRunRepository.listRuns(
      context.get("projectAccess").projectId,
      context.req.valid("query"),
    );
    return context.json({ evaluationRuns }, 200);
  });

  app.openapi(getEvaluationRunRoute, async (context) => {
    const { runId } = context.req.valid("param");
    const run = await evaluationRunRepository.readRun(
      context.get("projectAccess").projectId,
      runId,
    );
    if (run === null) return context.json(runNotFoundError(runId), 404);
    return context.json(run, 200);
  });

  app.openapi(listTestCaseResultsRoute, async (context) => {
    const { runId } = context.req.valid("param");
    const page = await evaluationRunRepository.listTestCaseResults(
      context.get("projectAccess").projectId,
      runId,
      context.req.valid("query"),
    );
    if (page === null) return context.json(runNotFoundError(runId), 404);
    return context.json(page, 200);
  });

  app.openapi(getTestCaseResultRoute, async (context) => {
    const { runId, testCaseName } = context.req.valid("param");
    const testCase = await evaluationRunRepository.readTestCaseResult(
      context.get("projectAccess").projectId,
      runId,
      testCaseName,
    );
    if (testCase === null) {
      return context.json(
        createErrorResponse("not_found", `Run ${runId} has no Test Case ${testCaseName}.`),
        404,
      );
    }
    return context.json(testCase, 200);
  });

  app.openapi(listReportDeliveriesRoute, async (context) => {
    const { runId } = context.req.valid("param");
    const reportDeliveries = await reportDeliveryRepository.listDeliveries(
      context.get("projectAccess").projectId,
      runId,
    );
    if (reportDeliveries === null) return context.json(runNotFoundError(runId), 404);
    return context.json({ reportDeliveries }, 200);
  });

  app.openapi(listIterationResultsRoute, async (context) => {
    const { runId, testCaseName } = context.req.valid("param");
    const page = await evaluationRunRepository.listIterationResults(
      context.get("projectAccess").projectId,
      runId,
      testCaseName,
      context.req.valid("query"),
    );
    if (page === null) {
      return context.json(
        createErrorResponse("not_found", `Run ${runId} has no Test Case ${testCaseName}.`),
        404,
      );
    }
    return context.json(page, 200);
  });

  app.openapi(getEvaluationRunWorkRoute, async (context) => {
    const { runId } = context.req.valid("param");
    const work = await evaluationRunRepository.readWork(
      context.get("projectAccess").projectId,
      runId,
    );
    if (work === null) return context.json(runNotFoundError(runId), 404);
    return context.json(work, 200);
  });

  app.openapi(reportIterationsRoute, async (context) => {
    const { runId } = context.req.valid("param");
    const { projectId } = context.get("projectAccess");
    const result = await evaluationRunRepository.reportIterations(
      projectId,
      runId,
      context.req.valid("json").reports,
      readCurrentTime(),
    );
    if (result === null) return context.json(runNotFoundError(runId), 404);
    await enqueueAfterCommit(result.jobs);
    const work = (await evaluationRunRepository.readWork(projectId, runId))!;
    return context.json({ ...work, rejected: result.rejected }, 200);
  });

  app.openapi(finishEvaluationRunRoute, async (context) => {
    const { runId } = context.req.valid("param");
    const { projectId } = context.get("projectAccess");
    const reportJobs = await evaluationRunRepository.requestFinish(
      projectId,
      runId,
      readCurrentTime(),
    );
    if (reportJobs === null) return context.json(runNotFoundError(runId), 404);
    await enqueueAfterCommit(reportJobs);
    return context.json((await evaluationRunRepository.readWork(projectId, runId))!, 200);
  });
}
