/** Server-Driven Execution of a multi-step Session Test Case against the sample Target. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  EvaluationRunSummary,
  EvaluationRunWork,
  ListIterationResultsResponse,
  Target,
} from "@extispex/contracts";
import { waitForCondition } from "./browser.ts";
import { startDeployment } from "./deployment.ts";
import { SAMPLE_TARGET_TOKEN, startSampleTarget } from "./sample-target.ts";
import { callGateway } from "./sign-in.ts";

const TARGET_TOKEN = SAMPLE_TARGET_TOKEN;

const CANCEL_SESSION_TEST_CASE = {
  name: "cancel-order",
  scope: "session",
  steps: [
    { input: { message: "Where is my order?" } },
    { input: { message: "Can I cancel it?" } },
  ],
  evaluators: [
    { type: "regex", name: "first-answer", pattern: "ships today", step: 1 },
    { type: "regex", name: "mentions-refund", pattern: "30 days" },
    // Each tool is called in a different step, so only the whole Session has both.
    {
      type: "telemetry",
      name: "looked-up",
      match: { name: "execute_tool", attributes: { "gen_ai.tool.name": "lookup_order" } },
    },
    {
      type: "telemetry",
      name: "cancelled",
      match: { name: "execute_tool", attributes: { "gen_ai.tool.name": "cancel_order" } },
    },
  ],
  iterations: 2,
};

Deno.test({
  name: "Server-Driven Execution through the gateway",
  // A container has its own network, so it cannot call a Target on this machine.
  ignore: Deno.env.get("E2E_DEPLOYMENT") === "external",
  fn: async (testContext) => {
    const deployment = await startDeployment();
    assert(deployment.canCallLocalTargets);
    const sampleTarget = await startSampleTarget(deployment);
    const bearerToken = deployment.apiKey;
    const uniquePart = crypto.randomUUID().slice(0, 8);
    const datasetName = `e2e-session-${uniquePart}`;

    const runToTheEnd = async (targetName: string) => {
      const work = await callGateway<EvaluationRunWork>(
        deployment,
        "POST",
        "/v1/evaluation-runs",
        201,
        { bearerToken, body: { datasetName, executionMode: "server", targetName } },
      );
      assertEquals(work.items, []);
      const runPath = `/v1/evaluation-runs/${work.runId}`;
      await waitForCondition("the run finished", async () => {
        const run = await callGateway<EvaluationRunSummary>(deployment, "GET", runPath, 200, {
          bearerToken,
        });
        return run.status === "finished";
      }, 60_000);
      const run = await callGateway<EvaluationRunSummary>(deployment, "GET", runPath, 200, {
        bearerToken,
      });
      const { iterations } = await callGateway<ListIterationResultsResponse>(
        deployment,
        "GET",
        `${runPath}/test-cases/cancel-order/iterations`,
        200,
        { bearerToken },
      );
      return { run, iterations };
    };

    try {
      await callGateway(deployment, "POST", "/v1/datasets", 201, {
        bearerToken,
        body: { name: datasetName },
      });
      await callGateway(deployment, "POST", `/v1/datasets/${datasetName}/test-cases`, 201, {
        bearerToken,
        body: CANCEL_SESSION_TEST_CASE,
      });

      await testContext.step("keeps the Target's credential to itself", async () => {
        const target = await callGateway<Target>(deployment, "POST", "/v1/targets", 201, {
          bearerToken,
          body: {
            name: `sample-${uniquePart}`,
            url: sampleTarget.url,
            credential: { headerName: "Authorization", headerValue: `Bearer ${TARGET_TOKEN}` },
          },
        });
        assertEquals(target.credentialHeaderName, "Authorization");
        assert(!JSON.stringify(target).includes(TARGET_TOKEN));
      });

      await testContext.step("judges a multi-step Session across all of its spans", async () => {
        const { run, iterations } = await runToTheEnd(`sample-${uniquePart}`);
        assertEquals([run.executionMode, run.targetName, run.verdict], [
          "server",
          `sample-${uniquePart}`,
          "passed",
        ]);
        assertEquals(iterations.length, 2);
        const [attempt] = iterations[0].attempts;
        assertEquals(attempt.transcript?.map((step) => step.input), [
          { message: "Where is my order?" },
          { message: "Can I cancel it?" },
        ]);
        const sessionIds = new Set(attempt.transcript?.map((step) => step.sessionId));
        assertEquals(sessionIds.size, 1);
        assertEquals(
          attempt.evaluatorResults.map((result) => [result.name, result.outcome]),
          [
            ["first-answer", "passed"],
            ["mentions-refund", "passed"],
            ["looked-up", "passed"],
            ["cancelled", "passed"],
          ],
        );
        // Each Iteration is its own Session, so the two never mix their telemetry.
        assert(iterations[0].attempts[0].sessionId !== iterations[1].attempts[0].sessionId);
      });

      await testContext.step("ends as Error when the Target refuses the credential", async () => {
        await callGateway(deployment, "POST", "/v1/targets", 201, {
          bearerToken,
          body: { name: `no-token-${uniquePart}`, url: sampleTarget.url },
        });
        const { run, iterations } = await runToTheEnd(`no-token-${uniquePart}`);
        assertEquals(run.verdict, "error");
        assertEquals(iterations[0].attempts.length, 3);
        assertStringIncludes(iterations[0].attempts[0].error ?? "", "status 401");
      });

      await testContext.step("documents Targets publicly", async () => {
        const openApiDocument = await callGateway<{ paths: Record<string, unknown> }>(
          deployment,
          "GET",
          "/v1/openapi.json",
          200,
          { bearerToken },
        );
        assert("/v1/targets/{targetName}" in openApiDocument.paths);
        assert(!JSON.stringify(openApiDocument).includes("sessions/{sessionId}/spans"));
      });
    } finally {
      await sampleTarget.stop();
      await deployment.stop();
    }
  },
});
