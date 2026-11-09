/** Browser tests of Datasets, Test Cases and Evaluation Runs, and their layout rules. */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { EvaluationRunWork } from "@extispex/contracts";
import type { Browser } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  forgetExpectedRequestFailures,
  launchBrowser,
  openUi,
} from "./browser.ts";
import { startDeployment } from "./deployment.ts";
import { createToolCallSpans, createTraceId, sendSpans } from "./otlp-json.ts";
import { callGateway } from "./sign-in.ts";

const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);

Deno.test({
  name: "evaluation web UI",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    const datasetName = `ui-support-${crypto.randomUUID().slice(0, 8)}`;
    const datasetPath = `/datasets/${datasetName}`;
    let runPath = "";
    const telemetryDatasetName = `ui-telemetry-${crypto.randomUUID().slice(0, 8)}`;
    const telemetryDatasetPath = `/datasets/${telemetryDatasetName}`;
    let telemetryRunPath = "";
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      const openEvaluationUi = (path: string, width = 1440) =>
        openUi(openBrowser, deployment, { width, account: deployment.admin, path });

      await testContext.step("creates a Dataset and a Test Case", async () => {
        const uiSession = await openEvaluationUi("/datasets");
        const { page } = uiSession;
        await page.getByLabel("Dataset name").fill(datasetName);
        await page.getByRole("button", { name: "Create Dataset" }).click();
        await page.getByRole("heading", { name: datasetName, level: 1 }).waitFor();
        await page.getByRole("link", { name: "New Test Case" }).click();
        await page.getByRole("heading", { name: "New Test Case", level: 1 }).waitFor();
        await page.getByLabel("Name", { exact: true }).fill("refund");
        await page.getByLabel("Input").fill('{"message": "Refund?"}');
        await page.getByLabel("Iterations").fill("2");
        await page.getByLabel("Evaluator 1 name").fill("mentions-days");
        await page.getByLabel("Evaluator 1 regular expression").fill("30\\s*days");
        await page.getByRole("button", { name: "Create Test Case" }).click();
        await page.getByRole("link", { name: "refund" }).waitFor();
        assertEquals(new URL(page.url()).pathname, datasetPath);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("explains an invalid regular expression", async () => {
        const uiSession = await openEvaluationUi(`${datasetPath}/new-test-case`);
        const { page } = uiSession;
        await page.getByLabel("Name", { exact: true }).fill("invalid");
        await page.getByLabel("Input").fill("Hello");
        await page.getByLabel("Evaluator 1 name").fill("broken");
        await page.getByLabel("Evaluator 1 regular expression").fill("(");
        await page.getByRole("button", { name: "Create Test Case" }).click();
        assertStringIncludes(
          await page.locator(".form-problem").innerText(),
          "not a valid regular expression",
        );
        forgetExpectedRequestFailures(uiSession, [400]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("edits a Test Case", async () => {
        const uiSession = await openEvaluationUi(`${datasetPath}/test-cases/refund`);
        const { page } = uiSession;
        const threshold = page.getByLabel("Pass Threshold");
        assertEquals(await threshold.inputValue(), "100");
        await threshold.fill("50");
        await page.getByRole("button", { name: "Save Test Case" }).click();
        await page.getByRole("cell", { name: "50%" }).waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("shows a run's results", async () => {
        const bearerToken = deployment.apiKey;
        const work = await callGateway<EvaluationRunWork>(
          deployment,
          "POST",
          "/v1/evaluation-runs",
          201,
          { bearerToken, body: { datasetName, executionMode: "client" } },
        );
        runPath = `/evaluation-runs/${work.runId}`;
        await callGateway(deployment, "POST", `${runPath.replace("/", "/v1/")}/reports`, 200, {
          bearerToken,
          body: {
            reports: work.items.map((item, itemIndex) => ({
              iterationId: item.iterationId,
              attempt: item.attempt,
              output: itemIndex === 0 ? "Within 30 days." : "I do not know.",
              correlationId: `ui-${item.iterationId}`,
            })),
          },
        });
        const uiSession = await openEvaluationUi("/evaluation-runs");
        const { page } = uiSession;
        await page.getByRole("link", { name: datasetName }).click();
        await page.getByRole("heading", { name: datasetName, level: 1 }).waitFor();
        // The page refreshes itself until the worker has judged both Outputs.
        await page.locator(".run-verdict .verdict-passed").waitFor({ timeout: 30_000 });
        await page.getByRole("button", { name: "Show Iterations" }).click();
        await page.locator(".iteration-row").nth(1).waitFor();
        assertEquals(
          await page.locator(".iteration-row .iteration-row-heading .status-badge").allInnerTexts(),
          [
            "Passed",
            "Failed",
          ],
        );
        assertStringIncludes(await page.locator(".attempt-output").first().innerText(), "30 days");
        assertStringIncludes(
          await page.locator(".evaluator-result-reason").last().innerText(),
          "does not match",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("creates a Telemetry Evaluator", async () => {
        await callGateway(deployment, "POST", "/v1/datasets", 201, {
          bearerToken: deployment.apiKey,
          body: { name: telemetryDatasetName },
        });
        const uiSession = await openEvaluationUi(`${telemetryDatasetPath}/new-test-case`);
        const { page } = uiSession;
        await page.getByLabel("Name", { exact: true }).fill("tool-call");
        await page.getByLabel("Input").fill("Refund?");
        await page.getByLabel("Evaluator 1 name").fill("answers");
        await page.getByLabel("Evaluator 1 regular expression").fill(".+");
        await page.getByRole("button", { name: "Add Telemetry Evaluator" }).click();
        await page.getByLabel("Evaluator 2 name").fill("called-lookup");
        await page.getByLabel("Evaluator 2 span name").fill("execute_tool");
        await page.getByLabel("Evaluator 2 attributes").fill("not json");
        await page.getByRole("button", { name: "Create Test Case" }).click();
        assertStringIncludes(await page.locator(".form-problem").innerText(), "JSON object");
        await page.getByLabel("Evaluator 2 attributes").fill(
          '{"gen_ai.tool.name": "lookup_refund"}',
        );
        await page.getByRole("button", { name: "Create Test Case" }).click();
        await page.getByRole("link", { name: "tool-call" }).waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("shows the spans a Telemetry Evaluator matched", async () => {
        const bearerToken = deployment.apiKey;
        const work = await callGateway<EvaluationRunWork>(
          deployment,
          "POST",
          "/v1/evaluation-runs",
          201,
          { bearerToken, body: { datasetName: telemetryDatasetName, executionMode: "client" } },
        );
        telemetryRunPath = `/evaluation-runs/${work.runId}`;
        const correlationId = `ui-telemetry-${work.items[0].iterationId}`;
        await sendSpans(
          deployment,
          createTraceId(),
          { correlationId },
          createToolCallSpans("lookup_refund"),
        );
        await callGateway(deployment, "POST", `/v1/evaluation-runs/${work.runId}/reports`, 200, {
          bearerToken,
          body: {
            reports: [{
              iterationId: work.items[0].iterationId,
              attempt: 1,
              output: "Done",
              correlationId,
            }],
          },
        });
        const uiSession = await openEvaluationUi(telemetryRunPath, SWEPT_WIDTHS[0]);
        const { page } = uiSession;
        await page.locator(".run-verdict .verdict-passed").waitFor({ timeout: 30_000 });
        await page.getByRole("button", { name: "Show Iterations" }).click();
        const matchedSpanLink = page.locator(".matched-span a");
        await matchedSpanLink.waitFor();
        assertEquals(await matchedSpanLink.innerText(), "execute_tool");
        for (const width of SWEPT_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await assertNoHorizontalOverflow(page, `with matched spans at ${width}px`);
        }
        await matchedSpanLink.click();
        await page.locator(".span-details h3").filter({ hasText: "execute_tool" }).waitFor();
        assertEquals(new URL(page.url()).searchParams.get("correlationId"), correlationId);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      for (
        const [pageName, resolvePath] of [
          ["Dataset list", () => "/datasets"],
          ["Dataset", () => datasetPath],
          ["Test Case editor", () => `${datasetPath}/test-cases/refund`],
          ["run list", () => "/evaluation-runs"],
          ["run", () => runPath],
          [
            "Test Case editor with a Telemetry Evaluator",
            () => `${telemetryDatasetPath}/test-cases/tool-call`,
          ],
          ["run with a Telemetry Evaluator", () => telemetryRunPath],
        ] as const
      ) {
        await testContext.step(`never scrolls the ${pageName} page sideways`, async () => {
          const uiSession = await openEvaluationUi(resolvePath(), SWEPT_WIDTHS[0]);
          const { page } = uiSession;
          await page.locator(".page h1").waitFor();
          await page.locator(".panel-loading").waitFor({ state: "detached" });
          for (const width of SWEPT_WIDTHS) {
            await page.setViewportSize({ width, height: 900 });
            await assertNoHorizontalOverflow(page, `on the ${pageName} page at ${width}px`);
          }
          assertNoPageErrors(uiSession);
          await uiSession.close();
        });
      }
    } finally {
      await browser?.close();
      await deployment.stop();
    }
  },
});
