/** Browser tests of LLM providers, the Grading Evaluator editor and the LLM Summary on a run. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Browser } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  launchBrowser,
  openUi,
} from "./browser.ts";
import { startDeployment } from "./deployment.ts";
import { FAKE_SUMMARY_TEXT, startFakeLlmProvider } from "./fake-llm-provider.ts";
import { SAMPLE_TARGET_TOKEN, startSampleTarget } from "./sample-target.ts";
import { callGateway } from "./sign-in.ts";

const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);

Deno.test({
  name: "LLM provider and Grading Evaluator web UI",
  // A container has its own network, so it cannot call a provider on this machine.
  ignore: Deno.env.get("E2E_DEPLOYMENT") === "external",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    const sampleTarget = await startSampleTarget(deployment);
    const fakeProvider = startFakeLlmProvider();
    let browser: Browser | null = null;
    const uniquePart = crypto.randomUUID().slice(0, 8);
    const providerName = `ui-judge-${uniquePart}`;
    const promptName = `ui-grader-${uniquePart}`;
    const datasetName = `ui-grading-${uniquePart}`;
    const targetName = `ui-target-${uniquePart}`;
    const bearerToken = deployment.apiKey;
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      const openAppUi = (path: string, width = 1440) =>
        openUi(openBrowser, deployment, { width, account: deployment.admin, path });
      const sweepWidths = async (
        page: Parameters<typeof assertNoHorizontalOverflow>[0],
        label: string,
      ) => {
        for (const width of SWEPT_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await assertNoHorizontalOverflow(page, `on ${label} at ${width}px`);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
      };

      await testContext.step("adds a provider and chooses it for LLM Summaries", async () => {
        const uiSession = await openAppUi("/llm-providers");
        const { page } = uiSession;
        await page.getByRole("link", { name: "LLM providers" }).waitFor();
        await page.getByLabel("Name", { exact: true }).fill(providerName);
        await page.getByLabel("Kind").selectOption("openai_compatible");
        await page.getByLabel("Base URL").fill(`${fakeProvider.url}/v1`);
        await page.getByLabel("Default model").fill("gpt-ui");
        await page.getByLabel("API key").fill("sk-ui-secret-key");
        await page.getByRole("button", { name: "Add LLM provider" }).click();
        await page.getByRole("heading", { name: providerName, level: 1 }).waitFor();
        assertStringIncludes(
          await page.locator(".llm-provider-form").innerText(),
          "An API key is stored encrypted.",
        );
        assert(!(await page.content()).includes("sk-ui-secret-key"));
        await sweepWidths(page, "an LLM provider");

        await page.goto(new URL("/llm-providers", page.url()).href);
        await page.getByRole("link", { name: providerName }).waitFor();
        await page.getByLabel("Summary provider").selectOption(providerName);
        await page.getByRole("button", { name: "Save LLM Summary settings" }).click();
        await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
        await sweepWidths(page, "the LLM provider list");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("configures a Grading Evaluator with a Prompt Version", async () => {
        await callGateway(deployment, "POST", "/v1/prompts", 201, {
          bearerToken,
          body: {
            name: promptName,
            type: "chat",
            messages: [
              { role: "system", content: "Pass only if the bot names the refund period." },
              { role: "user", content: "{{transcript}}" },
            ],
          },
        });
        await callGateway(deployment, "POST", "/v1/datasets", 201, {
          bearerToken,
          body: { name: datasetName },
        });
        await callGateway(deployment, "POST", "/v1/llm-providers", 201, {
          bearerToken,
          body: {
            name: `jev-${uniquePart}`,
            kind: "typesafe",
            baseUrl: fakeProvider.url,
            apiKey: "ts-ui-secret-key",
            defaultModel: "jev-latest",
          },
        });
        const uiSession = await openAppUi(`/datasets/${datasetName}/new-test-case`);
        const { page } = uiSession;
        await page.getByLabel("Name", { exact: true }).fill("cancel-order");
        await page.getByRole("radio", { name: "A whole Session" }).click();
        await page.getByLabel("Step 1 input").fill('{"message": "Where is my order?"}');
        await page.getByLabel("Step 2 input").fill('{"message": "Can I cancel it?"}');
        await page.getByRole("button", { name: "Add Grading Evaluator" }).click();
        await page.getByRole("button", { name: "Remove Evaluator 1" }).click();
        await page.getByLabel("Evaluator 1 name").fill("names-refund-period");
        await page.getByLabel("Evaluator 1 LLM provider").selectOption(providerName);
        await page.getByLabel("Evaluator 1 prompt", { exact: true }).selectOption(promptName);
        assertEquals(await page.getByLabel("Evaluator 1 Prompt Version").inputValue(), "1");
        await sweepWidths(page, "the Grading Evaluator editor");
        // A Judgment provider asks a typed question instead of sending a prompt.
        await page.getByRole("button", { name: "Add Grading Evaluator" }).click();
        await page.getByLabel("Evaluator 2 LLM provider").selectOption(`jev-${uniquePart}`);
        await page.getByLabel("Evaluator 2 question type").selectOption("choice");
        await page.getByLabel("Evaluator 2 choice 1 name").waitFor();
        await sweepWidths(page, "a Choice question");
        await page.getByRole("button", { name: "Remove Evaluator 2" }).click();
        await page.getByRole("button", { name: "Create Test Case" }).click();
        await page.getByRole("cell", { name: "Session, 2 steps" }).waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("shows the verdict's explanation and the LLM Summary", async () => {
        await callGateway(deployment, "POST", "/v1/targets", 201, {
          bearerToken,
          body: {
            name: targetName,
            url: sampleTarget.url,
            credential: {
              headerName: "Authorization",
              headerValue: `Bearer ${SAMPLE_TARGET_TOKEN}`,
            },
          },
        });
        const uiSession = await openAppUi(`/datasets/${datasetName}`);
        const { page } = uiSession;
        await page.getByLabel("Target", { exact: true }).selectOption(targetName);
        await page.getByRole("button", { name: "Run against Target" }).click();
        await page.locator(".run-verdict .verdict-passed").waitFor({ timeout: 30_000 });
        const summary = page.getByRole("region", { name: "LLM Summary" });
        await summary.getByText(FAKE_SUMMARY_TEXT).waitFor({ timeout: 30_000 });
        assertStringIncludes(await summary.innerText(), "with the default prompt");
        await page.getByRole("button", { name: "Show Iterations" }).click();
        await page.locator(".evaluator-result-reason").waitFor();
        assertEquals(
          await page.locator(".evaluator-result-reason").innerText(),
          "The bot states the 30-day refund period.",
        );
        assertStringIncludes(await page.locator(".evaluator-result").innerText(), "score 0.90");
        await sweepWidths(page, "a run with an LLM Summary");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });
    } finally {
      await callGateway(deployment, "PUT", "/v1/llm-summary-settings", 200, {
        bearerToken,
        body: { providerName: null },
      }).catch(() => {});
      await browser?.close();
      await fakeProvider.stop();
      await sampleTarget.stop();
      await deployment.stop();
    }
  },
});
