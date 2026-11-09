/** Trace completion, protection against mixed telemetry and the Telemetry Evaluator on real spans. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  EvaluationRunSummary,
  EvaluationRunWork,
  IterationAttempt,
  IterationReport,
  ListIterationResultsResponse,
  ReportIterationsResponse,
  TraceDetailResponse,
} from "@extispex/contracts";
import { waitForCondition } from "./browser.ts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";
import { createToolCallSpans, createTraceId, sendSpans } from "./otlp-json.ts";
import { callGateway } from "./sign-in.ts";

const CALLED_LOOKUP_EVALUATOR = {
  type: "telemetry",
  name: "called-lookup",
  match: { name: "execute_tool", attributes: { "gen_ai.tool.name": "lookup_refund" } },
};

function createRunner(deployment: RunningDeployment) {
  const bearerToken = deployment.apiKey;
  const runPath = (runId: string) => `/v1/evaluation-runs/${runId}`;

  const startRunOfNewDataset = async (datasetName: string) => {
    await callGateway(deployment, "POST", "/v1/datasets", 201, {
      bearerToken,
      body: { name: datasetName },
    });
    await callGateway(deployment, "POST", `/v1/datasets/${datasetName}/test-cases`, 201, {
      bearerToken,
      body: { name: "refund", input: "Refund?", evaluators: [CALLED_LOOKUP_EVALUATOR] },
    });
    return await callGateway<EvaluationRunWork>(deployment, "POST", "/v1/evaluation-runs", 201, {
      bearerToken,
      body: { datasetName, executionMode: "client" },
    });
  };

  const report = (runId: string, reports: IterationReport[]) =>
    callGateway<ReportIterationsResponse>(deployment, "POST", `${runPath(runId)}/reports`, 200, {
      bearerToken,
      body: { reports },
    });

  const readWork = (runId: string) =>
    callGateway<EvaluationRunWork>(deployment, "GET", `${runPath(runId)}/work`, 200, {
      bearerToken,
    });

  const readRun = (runId: string) =>
    callGateway<EvaluationRunSummary>(deployment, "GET", runPath(runId), 200, { bearerToken });

  const readAttempts = async (runId: string): Promise<IterationAttempt[]> => {
    const { iterations } = await callGateway<ListIterationResultsResponse>(
      deployment,
      "GET",
      `${runPath(runId)}/test-cases/refund/iterations`,
      200,
      { bearerToken },
    );
    return iterations[0].attempts;
  };

  const waitForAttemptOutcome = async (runId: string, attemptNumber: number) => {
    await waitForCondition(`attempt ${attemptNumber} was judged`, async () => {
      const attempts = await readAttempts(runId);
      return attempts[attemptNumber - 1]?.outcome != null;
    }, 30_000);
    return (await readAttempts(runId))[attemptNumber - 1];
  };

  return { report, readWork, readRun, readAttempts, waitForAttemptOutcome, startRunOfNewDataset };
}

Deno.test("Telemetry Evaluator through the gateway", async (testContext) => {
  const deployment = await startDeployment();
  const runner = createRunner(deployment);
  const uniquePart = crypto.randomUUID().slice(0, 8);
  const newCorrelationId = (label: string) => `e2e-${label}-${crypto.randomUUID()}`;

  try {
    let judgedCorrelationId = "";
    let judgedTraceId = "";

    await testContext.step("passes on spans that match", async () => {
      const work = await runner.startRunOfNewDataset(`e2e-telemetry-pass-${uniquePart}`);
      judgedCorrelationId = newCorrelationId("pass");
      judgedTraceId = createTraceId();
      await sendSpans(
        deployment,
        judgedTraceId,
        { correlationId: judgedCorrelationId },
        createToolCallSpans("lookup_refund"),
      );
      await runner.report(work.runId, [{
        iterationId: work.items[0].iterationId,
        attempt: 1,
        output: "Done",
        correlationId: judgedCorrelationId,
      }]);
      const attempt = await runner.waitForAttemptOutcome(work.runId, 1);
      assertEquals(attempt.outcome, "passed");
      const [result] = attempt.evaluatorResults;
      assertEquals(result.matchedSpanCount, 1);
      assertEquals(result.matchedSpans?.[0].name, "execute_tool");
      assertEquals(result.matchedSpans?.[0].traceId, judgedTraceId);
      assertEquals(result.matchedSpans?.[0].attributes, { "gen_ai.tool.name": "lookup_refund" });
      assertEquals((await runner.readRun(work.runId)).verdict, "passed");
    });

    await testContext.step("flags a span that arrives after the evaluation", async () => {
      await sendSpans(deployment, judgedTraceId, { correlationId: judgedCorrelationId }, [{
        name: "late-span",
        parentSpanId: "00f067aa0ba902b7",
      }]);
      const { spans } = await callGateway<TraceDetailResponse>(
        deployment,
        "GET",
        `/v1/traces/${judgedTraceId}`,
        200,
        { bearerToken: deployment.apiKey },
      );
      const arrivalFlags = Object.fromEntries(
        spans.map((span) => [span.name, span.arrivedAfterEvaluation]),
      );
      assertEquals(arrivalFlags, {
        "handle-message": false,
        execute_tool: false,
        "late-span": true,
      });
    });

    await testContext.step("fails on spans that do not match", async () => {
      const work = await runner.startRunOfNewDataset(`e2e-telemetry-fail-${uniquePart}`);
      const correlationId = newCorrelationId("fail");
      await sendSpans(
        deployment,
        createTraceId(),
        { correlationId },
        createToolCallSpans("another_tool"),
      );
      await runner.report(work.runId, [{
        iterationId: work.items[0].iterationId,
        attempt: 1,
        output: "Done",
        correlationId,
      }]);
      const attempt = await runner.waitForAttemptOutcome(work.runId, 1);
      assertEquals(attempt.outcome, "failed");
      assertEquals(attempt.evaluatorResults[0].matchedSpanCount, 0);
      assertEquals((await runner.readRun(work.runId)).verdict, "failed");
    });

    await testContext.step("ends the Iteration as Error without a root span", async () => {
      const work = await runner.startRunOfNewDataset(`e2e-telemetry-no-root-${uniquePart}`);
      const iterationId = work.items[0].iterationId;
      for (const attemptNumber of [1, 2, 3]) {
        const correlationId = newCorrelationId(`no-root-${attemptNumber}`);
        await sendSpans(deployment, createTraceId(), { correlationId }, [{
          name: "execute_tool",
          parentSpanId: "00f067aa0ba902b7",
          attributes: { "gen_ai.tool.name": "lookup_refund" },
        }]);
        await runner.report(work.runId, [{
          iterationId,
          attempt: attemptNumber,
          output: "Done",
          correlationId,
        }]);
        const attempt = await runner.waitForAttemptOutcome(work.runId, attemptNumber);
        assertEquals(attempt.outcome, "error");
        assertStringIncludes(attempt.error ?? "", "No root span arrived");
      }
      const run = await runner.readRun(work.runId);
      assertEquals(run.status, "finished");
      assertEquals(run.verdict, "error");
    });

    await testContext.step("rejects a reused Correlation ID", async () => {
      const work = await runner.startRunOfNewDataset(`e2e-telemetry-reuse-${uniquePart}`);
      const iterationId = work.items[0].iterationId;
      // This Correlation ID already has spans, from the first step of this test.
      await runner.report(work.runId, [{
        iterationId,
        attempt: 1,
        output: "Done",
        correlationId: judgedCorrelationId,
      }]);
      const firstAttempt = await runner.waitForAttemptOutcome(work.runId, 1);
      assertEquals(firstAttempt.outcome, "error");
      assertStringIncludes(firstAttempt.error ?? "", "already had telemetry");

      await runner.report(work.runId, [{
        iterationId,
        attempt: 2,
        output: "Done",
        correlationId: judgedCorrelationId,
      }]);
      const secondAttempt = await runner.waitForAttemptOutcome(work.runId, 2);
      assertStringIncludes(secondAttempt.error ?? "", "also used by");

      const correlationId = newCorrelationId("fresh");
      await sendSpans(
        deployment,
        createTraceId(),
        { correlationId },
        createToolCallSpans("lookup_refund"),
      );
      await runner.report(work.runId, [{
        iterationId,
        attempt: 3,
        output: "Done",
        correlationId,
      }]);
      assertEquals((await runner.waitForAttemptOutcome(work.runId, 3)).outcome, "passed");
      assertEquals((await runner.readRun(work.runId)).verdict, "passed");
    });

    await testContext.step("keeps the worker's endpoints internal", async () => {
      const internalPath = `/internal/v1/correlations/${judgedCorrelationId}/evaluated`;
      const requestInit = {
        method: "POST",
        headers: {
          authorization: `Bearer ${deployment.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ evaluatedAt: new Date().toISOString() }),
      };
      const throughGateway = await fetch(`${deployment.gatewayUrl}${internalPath}`, requestInit);
      assertEquals(throughGateway.status, 404);
      await throughGateway.body?.cancel();
      // The OTLP port is open to exporters, so an API key must not reach these endpoints either.
      const onOtlpPort = await fetch(`${deployment.otlpHttpUrl}${internalPath}`, requestInit);
      assertEquals(onOtlpPort.status, 401);
      await onOtlpPort.body?.cancel();
    });

    await testContext.step("documents the Telemetry Evaluator publicly", async () => {
      const openApiDocument = await callGateway<{ paths: Record<string, unknown> }>(
        deployment,
        "GET",
        "/v1/openapi.json",
        200,
        { bearerToken: deployment.apiKey },
      );
      assert(JSON.stringify(openApiDocument).includes('"telemetry"'));
      assert(!Object.keys(openApiDocument.paths).some((path) => path.startsWith("/internal/")));
    });
  } finally {
    await deployment.stop();
  }
});
