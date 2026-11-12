/**
 * pg-boss under sustained load, as ADR 0001 asks: several scripts run a Dataset with
 * Client-Driven Execution again and again, so the API keeps queueing evaluation jobs and the
 * worker keeps taking them from pg-boss until every run has its verdict.
 */
import type { EvaluationRunWork, IterationReport } from "@extispex/contracts";
import type { RunningDeployment } from "@extispex/e2e-tests";
import { computePercentile, type LoadClient, runSenders, sleep } from "./load-client.ts";
import type { Measurement } from "./performance-results.ts";

export interface JobQueueSettings {
  testCaseCount: number;
  /** Scripts running at once, each starting its next run when the previous one finished. */
  scriptCount: number;
  runsPerScript: number;
}

const REPORT_BATCH_SIZE = 100;
const WORK_POLL_INTERVAL_MILLISECONDS = 200;
const RUN_TIMEOUT_MILLISECONDS = 600_000;

export async function measureJobQueue(
  deployment: RunningDeployment,
  loadClient: LoadClient,
  settings: JobQueueSettings,
): Promise<Measurement[]> {
  const gateway = (path: string) => `${deployment.gatewayUrl}${path}`;
  const apiKey = deployment.apiKey;
  const datasetName = `performance-${crypto.randomUUID().slice(0, 8)}`;
  await loadClient.sendJson(gateway("/v1/datasets"), "POST", apiKey, { name: datasetName }, 201);
  for (let testCaseIndex = 0; testCaseIndex < settings.testCaseCount; testCaseIndex++) {
    await loadClient.sendJson(
      gateway(`/v1/datasets/${datasetName}/test-cases`),
      "POST",
      apiKey,
      {
        name: `question-${testCaseIndex}`,
        input: { message: `What is the refund policy for order ${testCaseIndex}?` },
        evaluators: [{ type: "regex", name: "mentions-30-days", pattern: "30\\s*days" }],
      },
      201,
    );
  }

  const runDurations: number[] = [];
  const startedAt = performance.now();
  await runSenders(settings.scriptCount, async () => {
    for (let runIndex = 0; runIndex < settings.runsPerScript; runIndex++) {
      const runStartedAt = performance.now();
      let work = await loadClient.sendJson<EvaluationRunWork>(
        gateway("/v1/evaluation-runs"),
        "POST",
        apiKey,
        { datasetName, executionMode: "client", batchSize: REPORT_BATCH_SIZE },
        201,
      );
      const deadline = Date.now() + RUN_TIMEOUT_MILLISECONDS;
      while (work.status !== "finished") {
        if (Date.now() > deadline) throw new Error(`Run ${work.runId} did not finish in time.`);
        if (work.items.length > 0) {
          const reports: IterationReport[] = work.items.map((item) => ({
            iterationId: item.iterationId,
            attempt: item.attempt,
            output: "You can return anything within 30 days.",
            correlationId: crypto.randomUUID(),
          }));
          work = await loadClient.sendJson<EvaluationRunWork>(
            gateway(`/v1/evaluation-runs/${work.runId}/reports`),
            "POST",
            apiKey,
            { reports },
          );
        } else {
          await sleep(WORK_POLL_INTERVAL_MILLISECONDS);
          work = await loadClient.sendJson<EvaluationRunWork>(
            gateway(`/v1/evaluation-runs/${work.runId}/work`),
            "GET",
            apiKey,
          );
        }
      }
      if (work.verdict !== "passed") {
        throw new Error(`Run ${work.runId} ended with the verdict ${work.verdict}.`);
      }
      runDurations.push(performance.now() - runStartedAt);
    }
  });
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const jobCount = settings.scriptCount * settings.runsPerScript * settings.testCaseCount;
  return [
    {
      id: "evaluation-job-throughput",
      description: "Evaluation jobs through pg-boss",
      kind: "throughput",
      unit: "jobs/s",
      value: Math.round((jobCount / elapsedSeconds) * 10) / 10,
    },
    {
      id: "evaluation-run-duration-p95",
      description: `Run of ${settings.testCaseCount} Test Cases until its verdict, p95`,
      kind: "latency",
      unit: "ms",
      value: Math.round(computePercentile(runDurations, 0.95)),
    },
  ];
}
