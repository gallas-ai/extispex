/** Browser tests of Targets, Session Test Cases and Server-Driven runs, and their layout rules. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Browser } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  launchBrowser,
  openUi,
} from "./browser.ts";
import { startDeployment } from "./deployment.ts";
import { canRunSampleTarget, SAMPLE_TARGET_TOKEN, startSampleTarget } from "./sample-target.ts";
import { callGateway } from "./sign-in.ts";

const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);

Deno.test({
  name: "Target and Session web UI",
  ignore: !canRunSampleTarget(),
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    const sampleTarget = await startSampleTarget(deployment);
    let browser: Browser | null = null;
    const uniquePart = crypto.randomUUID().slice(0, 8);
    const targetName = `ui-target-${uniquePart}`;
    const datasetName = `ui-session-${uniquePart}`;
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      const openTargetUi = (path: string, width = 1440) =>
        openUi(openBrowser, deployment, { width, account: deployment.admin, path });
      const sweepWidths = async (
        page: Parameters<typeof assertNoHorizontalOverflow>[0],
        label: string,
      ) => {
        for (const width of SWEPT_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await assertNoHorizontalOverflow(page, `on ${label} at ${width}px`);
        }
      };

      await testContext.step("creates a Target without showing its credential again", async () => {
        const uiSession = await openTargetUi("/targets");
        const { page } = uiSession;
        await page.getByRole("link", { name: "Targets" }).waitFor();
        await page.getByLabel("Name", { exact: true }).fill(targetName);
        await page.getByLabel("URL").fill(sampleTarget.url);
        await page.getByLabel("Credential value").fill(`Bearer ${SAMPLE_TARGET_TOKEN}`);
        await page.getByRole("button", { name: "Create Target" }).click();
        await page.getByRole("heading", { name: targetName, level: 1 }).waitFor();
        assertStringIncludes(
          await page.locator(".target-form").innerText(),
          "A value for the header Authorization is stored encrypted.",
        );
        assert(!(await page.content()).includes(SAMPLE_TARGET_TOKEN));
        await sweepWidths(page, "a Target");
        await page.goto(new URL("/targets", page.url()).href);
        await page.getByRole("link", { name: targetName }).waitFor();
        await sweepWidths(page, "the Target list");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("creates a Session Test Case with steps", async () => {
        await callGateway(deployment, "POST", "/v1/datasets", 201, {
          bearerToken: deployment.apiKey,
          body: { name: datasetName },
        });
        const uiSession = await openTargetUi(`/datasets/${datasetName}/new-test-case`);
        const { page } = uiSession;
        await page.getByLabel("Name", { exact: true }).fill("cancel-order");
        await page.getByRole("radio", { name: "A whole Session" }).click();
        await page.getByLabel("Step 1 input").fill('{"message": "Where is my order?"}');
        await page.getByLabel("Step 2 input").fill('{"message": "Can I cancel it?"}');
        await page.getByLabel("Evaluator 1 name").fill("first-answer");
        await page.getByLabel("Evaluator 1 regular expression").fill("ships today");
        await page.getByLabel("Evaluator 1 step").selectOption("1");
        await sweepWidths(page, "the Session Test Case editor");
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByRole("button", { name: "Create Test Case" }).click();
        await page.getByRole("cell", { name: "Session, 2 steps" }).waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step(
        "runs the Dataset against the Target and shows the Transcript",
        async () => {
          const uiSession = await openTargetUi(`/datasets/${datasetName}`);
          const { page } = uiSession;
          await page.getByLabel("Target", { exact: true }).selectOption(targetName);
          await page.getByRole("button", { name: "Run against Target" }).click();
          await page.getByText(`calls the Target ${targetName}`).waitFor();
          await page.locator(".run-verdict .verdict-passed").waitFor({ timeout: 30_000 });
          await page.getByRole("button", { name: "Show Iterations" }).click();
          const transcriptSteps = page.locator(".transcript-step");
          await transcriptSteps.nth(1).waitFor();
          assertStringIncludes(await transcriptSteps.first().innerText(), "Where is my order?");
          assertStringIncludes(await transcriptSteps.nth(1).innerText(), "cancelled");
          assertEquals(
            await page.locator(".evaluator-result-reason").innerText(),
            "The Output of step 1 matches /ships today/.",
          );
          await sweepWidths(page, "a run with a Transcript");
          assertNoPageErrors(uiSession);
          await uiSession.close();
        },
      );
    } finally {
      await browser?.close();
      await sampleTarget.stop();
      await deployment.stop();
    }
  },
});
