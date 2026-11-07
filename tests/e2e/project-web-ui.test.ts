/**
 * Browser tests of the Projects pages: entering the Instance admin key, creating a Project and an
 * API key, using the key in the browser, revoking it and deleting the Project, and the layout rules
 * that keep those pages from scrolling sideways.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type { Browser } from "playwright-core";
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
  name: "project web UI",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    // A fresh name keeps the test apart from Projects that other runs leave in a shared database.
    const projectName = `ui-project-${crypto.randomUUID().slice(0, 8)}`;
    let projectPath = "";
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      const openAdminUi = (path: string, width = 1280) =>
        openUi(openBrowser, deployment, {
          width,
          apiKey: null,
          instanceAdminKey: deployment.instanceAdminKey,
          path,
        });

      await testContext.step("leads from the connect page to the Projects", async () => {
        const uiSession = await openUi(openBrowser, deployment, { width: 1280, apiKey: null });
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Connect to your Project" }).waitFor();
        await page.getByLabel("API key", { exact: true }).fill(
          "extispex_admin_notAProjectKey000000000000000000000",
        );
        await page.getByRole("button", { name: "Connect" }).click();
        assertStringIncludes(
          await page.locator(".connect-form [role=alert]").innerText(),
          "Instance admin key",
        );
        await page.getByRole("link", { name: "Manage Projects and API keys" }).click();
        await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
        await page.getByRole("heading", { name: "Enter the Instance admin key" }).waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("asks again for a rejected Instance admin key", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1280,
          apiKey: null,
          path: "/projects",
        });
        const { page } = uiSession;
        await page.getByLabel("Instance admin key", { exact: true }).fill("wrong-admin-key");
        await page.getByRole("button", { name: "Continue" }).click();
        assertStringIncludes(
          await page.locator(".admin-key-form [role=alert]").innerText(),
          "not accepted",
        );
        await page.getByLabel("Instance admin key", { exact: true }).fill(
          deployment.instanceAdminKey,
        );
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("button", { name: "Create Project" }).waitFor();
        await page.locator(".panel-loading").waitFor({ state: "detached" });
        assert(
          (await page.locator(".project-cell-name").allInnerTexts()).includes("Default"),
          "The first Project created on start should be listed.",
        );
        forgetExpectedRequestFailures(uiSession, [401]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("creates a Project and an API key used in this browser", async () => {
        const uiSession = await openAdminUi("/projects");
        const { page } = uiSession;
        await page.getByLabel("Project name").fill(projectName);
        await page.getByRole("button", { name: "Create Project" }).click();
        await page.getByRole("heading", { name: projectName, level: 1 }).waitFor();
        projectPath = new URL(page.url()).pathname;
        assertMatch(projectPath, /^\/projects\/[0-9a-f-]{36}$/);
        await page.getByText("This Project has no API keys yet.").waitFor();

        await page.getByLabel("New key's name").fill("CI pipeline");
        await page.getByRole("button", { name: "Create API key" }).click();
        const newKey = page.getByRole("status", { name: "New API key" });
        await newKey.waitFor();
        const apiKey = await newKey.locator(".new-api-key-secret").innerText();
        assertMatch(apiKey, /^extispex_[0-9A-Za-z]{43}$/);
        await page.locator(".api-key-row").waitFor();
        assertEquals(await page.locator(".api-key-name").allInnerTexts(), ["CI pipeline"]);
        assertEquals(await page.locator(".api-key-prefix").innerText(), `${apiKey.slice(0, 17)}…`);

        await newKey.getByRole("button", { name: "Use in this browser" }).click();
        await page.getByRole("heading", { name: "Traces", level: 1 }).waitFor();
        await page.getByText("No traces yet").waitFor();
        assertEquals(
          (await page.locator(".api-key-trigger").innerText()).trim(),
          `••••${apiKey.slice(-4)}`,
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("revokes an API key after confirmation", async () => {
        const uiSession = await openAdminUi(projectPath);
        const { page } = uiSession;
        await page.getByRole("button", { name: "Revoke CI pipeline" }).click();
        await page.getByRole("button", { name: "Cancel" }).click();
        assertEquals(await page.locator(".api-key-revoked").count(), 0);
        await page.getByRole("button", { name: "Revoke CI pipeline" }).click();
        await page.getByRole("button", { name: "Confirm revoke" }).click();
        await page.locator(".api-key-revoked").waitFor();
        assertEquals(await page.locator(".api-key-revoked .status-text").innerText(), "Revoked");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      for (
        const [pageName, path] of [["Project list", "/projects"], ["Project", "PROJECT"]]
      ) {
        await testContext.step(`never scrolls the ${pageName} page sideways`, async () => {
          const uiSession = await openAdminUi(path === "PROJECT" ? projectPath : path, 360);
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
        const uiSession = await openUi(openBrowser, deployment, {
          width: 360,
          apiKey: deployment.apiKey,
          instanceAdminKey: deployment.instanceAdminKey,
          path: "/projects",
        });
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
        const topBarHeight = await page.locator(".top-bar").evaluate((element) =>
          element.getBoundingClientRect().height
        );
        assertEquals(Math.round(topBarHeight), 52);
        assertEquals(
          await page.getByRole("link", { name: "Projects" }).getAttribute("aria-current"),
          "page",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("deletes a Project after confirmation", async () => {
        const uiSession = await openAdminUi(projectPath);
        const { page } = uiSession;
        await page.getByRole("button", { name: "Delete Project" }).click();
        await page.getByRole("button", { name: `Delete ${projectName}` }).click();
        await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
        await page.locator(".project-cell-name").first().waitFor();
        await waitForCondition(
          "the deleted Project is gone from the list",
          async () =>
            !(await page.locator(".project-cell-name").allInnerTexts()).includes(projectName),
        );
        await page.goto(projectPath);
        await page.getByRole("heading", { name: "This Project does not exist" }).waitFor();
        forgetExpectedRequestFailures(uiSession, [404]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });
    } finally {
      await browser?.close();
      await deployment.stop();
    }
  },
});
