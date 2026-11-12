/** Grading Evaluators and LLM Summaries through the Gateway, with a fake LLM provider. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  EvaluationRun,
  EvaluationRunWork,
  ListIterationResultsResponse,
  LlmProvider,
} from "@extispex/contracts";
import { waitForCondition } from "./browser.ts";
import { startDeployment } from "./deployment.ts";
import { FAKE_SUMMARY_TEXT, startFakeLlmProvider } from "./fake-llm-provider.ts";
import { SAMPLE_TARGET_TOKEN, startSampleTarget } from "./sample-target.ts";
import { callGateway } from "./sign-in.ts";

Deno.test({
  name: "Grading Evaluators and LLM Summaries through the gateway",
  // A container has its own network, so it cannot call a provider on this machine.
  ignore: Deno.env.get("E2E_DEPLOYMENT") === "external",
  fn: async (testContext) => {
    const deployment = await startDeployment();
    const sampleTarget = await startSampleTarget(deployment);
    const fakeProvider = startFakeLlmProvider();
    const bearerToken = deployment.apiKey;
    const uniquePart = crypto.randomUUID().slice(0, 8);
    const datasetName = `e2e-grading-${uniquePart}`;
    const judgeName = `judge-${uniquePart}`;
    const jevName = `jev-${uniquePart}`;
    const promptName = `grader-${uniquePart}`;
    const call = <ResponseBody>(
      method: string,
      path: string,
      expectedStatus: number,
      body?: unknown,
    ) => callGateway<ResponseBody>(deployment, method, path, expectedStatus, { bearerToken, body });

    try {
      await testContext.step("keeps an LLM provider's API key to itself", async () => {
        const judge = await call<LlmProvider>("POST", "/v1/llm-providers", 201, {
          name: judgeName,
          kind: "openai_compatible",
          baseUrl: `${fakeProvider.url}/v1`,
          apiKey: "sk-e2e-secret-key",
          defaultModel: "gpt-e2e",
        });
        assertEquals([judge.capabilities, judge.hasApiKey], [["text_generation"], true]);
        assert(!JSON.stringify(judge).includes("sk-e2e-secret-key"));
        await call("POST", "/v1/llm-providers", 201, {
          name: jevName,
          kind: "typesafe",
          baseUrl: fakeProvider.url,
          apiKey: "ts-e2e-secret-key",
          defaultModel: "jev-latest",
        });
        await call("PUT", "/v1/llm-summary-settings", 200, { providerName: judgeName });
      });

      await testContext.step(
        "judges a Session's Transcript and writes the LLM Summary",
        async () => {
          await call("POST", "/v1/prompts", 201, {
            name: promptName,
            type: "chat",
            messages: [
              { role: "system", content: "Pass only if the bot names the refund period." },
              { role: "user", content: "{{transcript}}" },
            ],
          });
          await call("POST", "/v1/datasets", 201, { name: datasetName });
          await call("POST", `/v1/datasets/${datasetName}/test-cases`, 201, {
            name: "cancel-order",
            scope: "session",
            steps: [
              { input: { message: "Where is my order?" } },
              { input: { message: "Can I cancel it?" } },
            ],
            evaluators: [
              {
                type: "grading",
                name: "names-refund-period",
                providerName: judgeName,
                prompt: { name: promptName, version: 1 },
              },
              {
                type: "grading",
                name: "jev-refund-period",
                providerName: jevName,
                question: {
                  type: "noul",
                  instructions: "Does the bot tell the customer when the refund arrives?",
                },
              },
            ],
          });
          await call("POST", "/v1/targets", 201, {
            name: `sample-${uniquePart}`,
            url: sampleTarget.url,
            credential: {
              headerName: "Authorization",
              headerValue: `Bearer ${SAMPLE_TARGET_TOKEN}`,
            },
          });
          const work = await call<EvaluationRunWork>("POST", "/v1/evaluation-runs", 201, {
            datasetName,
            executionMode: "server",
            targetName: `sample-${uniquePart}`,
          });
          const runPath = `/v1/evaluation-runs/${work.runId}`;
          await waitForCondition("the LLM Summary is written", async () => {
            const run = await call<EvaluationRun>("GET", runPath, 200);
            return run.status === "finished" && run.llmSummary?.status !== "pending";
          }, 60_000);
          const run = await call<EvaluationRun>("GET", runPath, 200);
          assertEquals(run.verdict, "passed");
          assertEquals(run.llmSummary?.status, "completed");
          assertEquals(run.llmSummary?.text, FAKE_SUMMARY_TEXT);
          assertEquals(run.llmSummary?.model, "gpt-e2e-fake");

          const { iterations } = await call<ListIterationResultsResponse>(
            "GET",
            `${runPath}/test-cases/cancel-order/iterations`,
            200,
          );
          const [result, jevResult] = iterations[0].attempts[0].evaluatorResults;
          assertEquals([result.type, result.outcome, result.score], ["grading", "passed", 0.9]);
          assertEquals(result.prompt?.name, promptName);
          assertEquals([jevResult.outcome, jevResult.model], ["passed", "jev-fake"]);
          // The Prompt Version came from the Prompt service, and the Transcript has both steps.
          const gradingRequest = fakeProvider.requests.find((request) =>
            request.path.endsWith("/chat/completions") && request.body.response_format
          );
          assert(gradingRequest !== undefined);
          const transcriptText = gradingRequest.body.messages[1].content as string;
          assertStringIncludes(transcriptText, "Where is my order?");
          assertStringIncludes(transcriptText, "The refund arrives within 30 days.");
        },
      );

      await testContext.step("documents LLM providers publicly", async () => {
        const openApiDocument = await call<{ paths: Record<string, unknown> }>(
          "GET",
          "/v1/openapi.json",
          200,
        );
        assert("/v1/llm-providers/{providerName}" in openApiDocument.paths);
        assert("/v1/llm-summary-settings" in openApiDocument.paths);
      });
    } finally {
      await call("PUT", "/v1/llm-summary-settings", 200, { providerName: null }).catch(() => {});
      await fakeProvider.stop();
      await sampleTarget.stop();
      await deployment.stop();
    }
  },
});
