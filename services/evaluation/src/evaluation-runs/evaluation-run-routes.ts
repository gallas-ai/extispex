import {
  createErrorResponse,
  createEvaluationRunRoute,
  finishEvaluationRunRoute,
  getEvaluationRunRoute,
  getEvaluationRunWorkRoute,
  listEvaluationRunsRoute,
  listIterationResultsRoute,
  listTestCaseResultsRoute,
  reportIterationsRoute,
} from "@extispex/contracts";
import type { ProjectAccessEnvironment, StructuredLogger } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { EvaluateAttemptJob, JobQueue } from "../job-queue/job-queue.ts";
import type { DatasetRepository } from "../storage/dataset-repository.ts";
import type { EvaluationRunRepository } from "../storage/evaluation-run-repository.ts";

export interface EvaluationRunRouteDependencies {
  datasetRepository: DatasetRepository;
  evaluationRunRepository: EvaluationRunRepository;
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
  const { datasetRepository, evaluationRunRepository, jobQueue, logger, readCurrentTime } =
    dependencies;

  /** A failure here is not the script's problem: the worker queues stalled attempts again. */
  const enqueueAfterCommit = async (jobs: EvaluateAttemptJob[]) => {
    try {
      await jobQueue.enqueue(jobs);
    } catch (error) {
      logger.error("Reported attempts could not be queued yet", { error, jobCount: jobs.length });
    }
  };

  app.openapi(createEvaluationRunRoute, async (context) => {
    const { datasetName, executionMode, batchSize } = context.req.valid("json");
    const { projectId } = context.get("projectAccess");
    const dataset = await datasetRepository.findDataset(projectId, datasetName);
    if (dataset === null) {
      return context.json(
        createErrorResponse("not_found", `Dataset ${datasetName} was not found.`),
        404,
      );
    }
    const start = await evaluationRunRepository.startRun({
      projectId,
      datasetId: dataset.id,
      datasetName,
      executionMode,
      batchSize,
    }, readCurrentTime());
    if (start.status === "no_test_cases") {
      return context.json(
        createErrorResponse("conflict", `Dataset ${datasetName} has no Test Cases.`),
        409,
      );
    }
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
    if (!await evaluationRunRepository.requestFinish(projectId, runId, readCurrentTime())) {
      return context.json(runNotFoundError(runId), 404);
    }
    return context.json((await evaluationRunRepository.readWork(projectId, runId))!, 200);
  });
}
