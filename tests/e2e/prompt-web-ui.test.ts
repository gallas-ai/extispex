/**
 * Browser tests of the Prompts pages: creating, versioning, labelling and comparing a prompt
 * through the UI, and the layout rules that keep those pages from scrolling sideways.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Browser, Page } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  forgetExpectedRequestFailures,
  launchBrowser,
  openUi,
  waitForCondition,
} from "./browser.ts";
import { startDeployment } from "./deployment.ts";

/** Every window width the layout must fit without scrolling sideways, phone to wide monitor. */
const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);

Deno.test({
  name: "prompt web UI",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    // A fresh name keeps the test apart from prompts that other runs leave in a shared database.
    const promptName = `ui-support-agent-${crypto.randomUUID().slice(0, 8)}`;
    const promptPath = `/prompts/${promptName}`;
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      const openPromptUi = (path: string, width = 1440) =>
        openUi(openBrowser, deployment, { width, apiKey: deployment.apiKey, path });

      await testContext.step("moves between Traces and Prompts", async () => {
        const uiSession = await openPromptUi("/");
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Traces", level: 1 }).waitFor();
        assertEquals(new URL(page.url()).pathname, "/traces");
        await page.getByRole("navigation", { name: "Sections" })
          .getByRole("link", { name: "Prompts" }).click();
        await page.getByRole("heading", { name: "Prompts", level: 1 }).waitFor();
        assertEquals(new URL(page.url()).pathname, "/prompts");
        assertEquals(
          await page.getByRole("link", { name: "Prompts" }).getAttribute("aria-current"),
          "page",
        );
        await page.goBack();
        await page.getByRole("heading", { name: "Traces", level: 1 }).waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("creates a prompt with its first version", async () => {
        const uiSession = await openPromptUi("/prompts");
        const { page } = uiSession;
        await page.getByRole("link", { name: "New prompt" }).click();
        await page.getByRole("heading", { name: "New prompt", level: 1 }).waitFor();
        await page.getByLabel("Name", { exact: true }).fill(promptName);
        await page.getByLabel("Description").fill("Answers customer questions");
        await page.getByLabel("Message 1", { exact: true }).fill(
          "You help customers of {{company}}.\nBe brief.",
        );
        await page.getByLabel("Message 2", { exact: true }).fill("{{question}}");
        await page.getByLabel("Model", { exact: true }).fill("gpt-4.1");
        await page.getByLabel("Temperature").fill("0.2");
        await page.getByLabel("Prompt Labels").fill("production");
        assertEquals(await readVariables(page), ["{{company}}", "{{question}}"]);

        await page.getByRole("button", { name: "Create prompt" }).click();
        await page.getByRole("heading", { name: "Version 1", level: 2 }).waitFor();
        assertEquals(new URL(page.url()).pathname, promptPath);
        await page.locator(".label-panel .label-row").waitFor();
        assertEquals(await readPromptLabels(page), ["production v1"]);
        assertEquals(await readLabelsOfShownVersion(page), ["production"]);
        assertEquals(await page.locator(".prompt-message-role").allInnerTexts(), [
          "System",
          "User",
        ]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("explains why a prompt could not be created", async () => {
        const uiSession = await openPromptUi("/new-prompt");
        const { page } = uiSession;
        await page.getByLabel("Name", { exact: true }).fill(promptName);
        await page.getByLabel("Message 1", { exact: true }).fill("Duplicate");
        await page.getByLabel("Message 2", { exact: true }).fill("{{question}}");
        await page.getByRole("button", { name: "Create prompt" }).click();
        assertStringIncludes(
          await page.locator(".editor-side [role=alert]").innerText(),
          "already exists",
        );
        forgetExpectedRequestFailures(uiSession, [409]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("adds a version that starts from the shown one", async () => {
        const uiSession = await openPromptUi(promptPath);
        const { page } = uiSession;
        await page.getByRole("link", { name: "New version" }).click();
        await page.getByRole("heading", { name: "New version", level: 1 }).waitFor();
        const systemMessage = page.getByLabel("Message 1", { exact: true });
        assertEquals(
          await systemMessage.inputValue(),
          "You help customers of {{company}}.\nBe brief.",
        );
        await systemMessage.fill("You help customers of {{company}}.\nBe friendly.");
        await page.getByLabel("Temperature").fill("0.7");
        await page.getByLabel("Commit message").fill("Friendlier tone");
        await page.getByRole("button", { name: "Save version" }).click();
        await page.getByRole("heading", { name: "Version 2", level: 2 }).waitFor();
        assertEquals(new URL(page.url()).searchParams.get("version"), "2");
        assertEquals(await page.locator(".version-item").count(), 2);
        assertEquals(
          await page.locator(".version-item-selected .version-item-message").innerText(),
          "Friendlier tone",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("moves a Prompt Label to the shown version", async () => {
        const uiSession = await openPromptUi(`${promptPath}?version=2`);
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Version 2", level: 2 }).waitFor();
        assertEquals(await readLabelsOfShownVersion(page), []);
        await page.getByRole("button", { name: "Move to v2" }).click();
        await waitForCondition(
          "the label points at version 2",
          async () => (await readPromptLabels(page)).join() === "production v2",
        );
        assertEquals(await readLabelsOfShownVersion(page), ["production"]);
        await page.locator(".version-item", { hasText: "v1" }).click();
        await page.getByRole("heading", { name: "Version 1", level: 2 }).waitFor();
        assertEquals(
          await readLabelsOfShownVersion(page),
          [],
          "A label that points to another version must not show on this one.",
        );
        assertEquals(await readPromptLabels(page), ["production v2"]);
        await page.goBack();
        await page.getByRole("heading", { name: "Version 2", level: 2 }).waitFor();
        await page.getByLabel("Label name").fill("not a valid name");
        await page.getByRole("button", { name: "Point at v2" }).click();
        await page.locator(".form-problem").waitFor();
        forgetExpectedRequestFailures(uiSession, [400]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("compares two versions line by line", async () => {
        const uiSession = await openPromptUi(`${promptPath}?version=2`);
        const { page } = uiSession;
        await page.getByRole("link", { name: "Compare" }).click();
        await page.getByRole("heading", { name: "Compare versions", level: 1 }).waitFor();
        const comparisonUrl = new URL(page.url());
        assertEquals(comparisonUrl.searchParams.get("fromVersion"), "1");
        assertEquals(comparisonUrl.searchParams.get("toVersion"), "2");
        await page.locator(".diff-line").first().waitFor();
        assertEquals(await page.locator(".diff-line-removed .diff-line-text").allInnerTexts(), [
          "Be brief.",
        ]);
        assertEquals(await page.locator(".diff-line-added .diff-line-text").allInnerTexts(), [
          "Be friendly.",
        ]);
        const temperatureRow = page.locator(".parameter-change-changed");
        assertEquals(await temperatureRow.locator(".parameter-change-from").innerText(), "0.2");
        assertEquals(await temperatureRow.locator(".parameter-change-to").innerText(), "0.7");

        await page.getByRole("button", { name: "Swap the versions" }).click();
        await waitForCondition(
          "the swapped comparison shows the old line as added",
          async () =>
            (await page.locator(".diff-line-added .diff-line-text").allInnerTexts()).join() ===
              "Be brief.",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      for (
        const [pageName, path] of [
          ["prompt list", "/prompts"],
          ["prompt", `${promptPath}?version=2`],
          ["comparison", `${promptPath}/compare?fromVersion=1&toVersion=2`],
          ["editor", `${promptPath}/versions/new?from=2`],
        ]
      ) {
        await testContext.step(`never scrolls the ${pageName} page sideways`, async () => {
          const uiSession = await openPromptUi(path, SWEPT_WIDTHS[0]);
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

      await testContext.step("keeps the top bar on one line on a phone", async () => {
        const uiSession = await openPromptUi("/prompts", 360);
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Prompts", level: 1 }).waitFor();
        const topBarHeight = await page.locator(".top-bar").evaluate((element) =>
          element.getBoundingClientRect().height
        );
        assertEquals(Math.round(topBarHeight), 52);
        // The section names give way to icons but stay the links' accessible names.
        const promptsLink = page.getByRole("link", { name: "Prompts" });
        assert(await promptsLink.isVisible());
        assert(
          (await promptsLink.evaluate((element) => element.getBoundingClientRect().width)) < 50,
          "The Prompts link should show only its icon on a phone.",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });
    } finally {
      await browser?.close();
      await deployment.stop();
    }
  },
});

async function readVariables(page: Page): Promise<string[]> {
  return await page.locator(".detected-variables .variable-badge").allInnerTexts();
}

/** The prompt's labels as "name vN", from the Prompt Labels panel beside the history. */
async function readPromptLabels(page: Page): Promise<string[]> {
  const labelRows: string[] = [];
  for (const labelRow of await page.locator(".label-panel .label-row").all()) {
    const labelName = await labelRow.locator(".label-badge-name").innerText();
    const versionNumber = await labelRow.locator(".version-badge").innerText();
    labelRows.push(`${labelName} ${versionNumber}`);
  }
  return labelRows;
}

/** The labels shown beside the selected version's heading: only those that point to it. */
async function readLabelsOfShownVersion(page: Page): Promise<string[]> {
  return await page.locator(".version-panel-header .label-badge-name").allInnerTexts();
}
