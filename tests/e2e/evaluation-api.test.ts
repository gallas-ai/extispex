import { assert, assertEquals } from "@std/assert";
import type {
  EvaluationRunSummary,
  EvaluationRunWork,
  IterationReport,
  ListIterationResultsResponse,
  ListTestCaseResultsResponse,
  ReportIterationsResponse,
} from "@extispex/contracts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";
import { callGateway, signInThroughGateway } from "./sign-in.ts";
import { waitForCondition } from "./browser.ts";

const REPOSITORY_ROOT = new URL("../../", import.meta.url).pathname;

function runExample(
  deployment: RunningDeployment,
  datasetName: string,
  command: string,
  scriptArguments: string[],
) {
  return new Deno.Command(command, {
    args: scriptArguments,
    cwd: REPOSITORY_ROOT,
    env: {
      API_KEY: deployment.apiKey,
      GATEWAY_URL: deployment.gatewayUrl,
      DATASET_NAME: datasetName,
    },
  }).output();
}

async function assertExampleRunPassed(
  deployment: RunningDeployment,
  datasetName: string,
  exampleOutput: Deno.CommandOutput,
): Promise<void> {
  const printedOutput = new TextDecoder().decode(exampleOutput.stdout);
  assert(
    exampleOutput.success,
    `${printedOutput}\n${new TextDecoder().decode(exampleOutput.stderr)}`,
  );
  assert(printedOutput.includes("Verdict: passed"), printedOutput);
  const runId = printedOutput.match(/Started run (\S+)/)![1];
  const bearerToken = deployment.apiKey;
  const run = await callGateway<EvaluationRunSummary>(
    deployment,
    "GET",
    `/v1/evaluation-runs/${runId}`,
    200,
    { bearerToken },
  );
  assertEquals(run.datasetName, datasetName);
  assertEquals(run.status, "finished");
  const { testCases } = await callGateway<ListTestCaseResultsResponse>(
    deployment,
    "GET",
    `/v1/evaluation-runs/${runId}/test-cases`,
    200,
    { bearerToken },
  );
  assertEquals(testCases.map((testCase) => testCase.outcome), ["passed", "passed"]);
  assertEquals(run.totalIterations, 4);
}

Deno.test("Client-Driven Execution through the gateway", async (testContext) => {
  const deployment = await startDeployment();
  const uniquePart = crypto.randomUUID().slice(0, 8);
  const bearerToken = deployment.apiKey;
  const datasetName = `e2e-support-${uniquePart}`;
  try {
    await testContext.step("runs a Dataset and retries a reported Error", async () => {
      await callGateway(deployment, "POST", "/v1/datasets", 201, {
        bearerToken,
        body: { name: datasetName },
      });
      await callGateway(deployment, "POST", `/v1/datasets/${datasetName}/test-cases`, 201, {
        bearerToken,
        body: {
          name: "refund",
          input: { message: "Refund?" },
          evaluators: [{ type: "regex", name: "days", pattern: "30\\s*days" }],
        },
      });
      const firstWork = await callGateway<EvaluationRunWork>(
        deployment,
        "POST",
        "/v1/evaluation-runs",
        201,
        { bearerToken, body: { datasetName, executionMode: "client" } },
      );
      const report = (reports: IterationReport[]) =>
        callGateway<ReportIterationsResponse>(
          deployment,
          "POST",
          `/v1/evaluation-runs/${firstWork.runId}/reports`,
          200,
          { bearerToken, body: { reports } },
        );
      const [firstItem] = firstWork.items;
      const retryWork = await report([{
        iterationId: firstItem.iterationId,
        attempt: 1,
        error: "HTTP 500",
      }]);
      assertEquals(retryWork.items.map((item) => item.attempt), [2]);
      await report([{
        iterationId: firstItem.iterationId,
        attempt: 2,
        output: "Within 30 days.",
        correlationId: `e2e-${uniquePart}`,
      }]);

      await waitForCondition("the worker judged the Output", async () => {
        const work = await callGateway<EvaluationRunWork>(
          deployment,
          "GET",
          `/v1/evaluation-runs/${firstWork.runId}/work`,
          200,
          { bearerToken },
        );
        return work.status === "finished";
      }, 30_000);
      const run = await callGateway<EvaluationRunSummary>(
        deployment,
        "GET",
        `/v1/evaluation-runs/${firstWork.runId}`,
        200,
        { bearerToken },
      );
      assertEquals(run.verdict, "passed");
      const { iterations } = await callGateway<ListIterationResultsResponse>(
        deployment,
        "GET",
        `/v1/evaluation-runs/${firstWork.runId}/test-cases/refund/iterations`,
        200,
        { bearerToken },
      );
      assertEquals(iterations[0].attempts.map((attempt) => attempt.outcome), ["error", "passed"]);
      assertEquals(iterations[0].attempts[1].correlationId, `e2e-${uniquePart}`);
    });

    await testContext.step("runs the TypeScript example", async () => {
      const exampleDataset = `e2e-typescript-${uniquePart}`;
      const exampleOutput = await runExample(deployment, exampleDataset, Deno.execPath(), [
        "run",
        "--allow-net",
        "--allow-env",
        "examples/typescript/run-dataset.ts",
      ]);
      await assertExampleRunPassed(deployment, exampleDataset, exampleOutput);
    });

    await testContext.step("runs the Python example", async () => {
      const exampleDataset = `e2e-python-${uniquePart}`;
      const exampleOutput = await runExample(deployment, exampleDataset, "python3", [
        "examples/python/run_dataset.py",
      ]);
      await assertExampleRunPassed(deployment, exampleDataset, exampleOutput);
    });

    await testContext.step("a user's token for the Project reads runs", async () => {
      const admin = await signInThroughGateway(deployment, deployment.admin);
      const { projects } = await callGateway<{ projects: { id: string; name: string }[] }>(
        deployment,
        "GET",
        "/v1/projects",
        200,
        { bearerToken: admin.accessToken },
      );
      const { accessToken } = await admin.requestProjectToken(projects[0].id);
      await callGateway(deployment, "GET", "/v1/evaluation-runs", 200, {
        bearerToken: accessToken,
      });
    });

    await testContext.step("documents the API and refuses a wrong key", async () => {
      const openApiDocument = await callGateway<{ paths: Record<string, unknown> }>(
        deployment,
        "GET",
        "/v1/openapi.json",
        200,
        { bearerToken },
      );
      assert("/v1/evaluation-runs/{runId}/reports" in openApiDocument.paths);
      await callGateway(deployment, "GET", "/v1/datasets", 401, { bearerToken: "wrong-key" });
    });
  } finally {
    await deployment.stop();
  }
});
