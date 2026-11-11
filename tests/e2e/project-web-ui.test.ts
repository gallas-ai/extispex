/**
 * Browser tests of the Projects and Access pages: creating a Project, giving a Group a Role in it,
 * switching to it, creating and revoking an API key, managing users and Groups, a viewer who
 * cannot change prompts, deleting the Project, and the layout rules that keep those pages from
 * scrolling sideways.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
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
    // Fresh names keep the test apart from data that other runs leave in a shared database.
    const uniquePart = crypto.randomUUID().slice(0, 8);
    const projectName = `ui-project-${uniquePart}`;
    const groupName = `UI viewers ${uniquePart}`;
    const viewer = {
      email: `ui-viewer-${uniquePart}@e2e.extispex.test`,
      password: "ui-viewer-pass",
    };
    let projectPath = "";
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      const openAdminUi = (path: string, width = 1280) =>
        openUi(openBrowser, deployment, { width, account: deployment.admin, path });

      await testContext.step("lists the Projects with the user's Role in each", async () => {
        const uiSession = await openAdminUi("/projects");
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
        const defaultRow = page.locator("tr", { has: page.getByRole("link", { name: "Default" }) });
        assertEquals(await defaultRow.locator(".role-badge").innerText(), "admin");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step(
        "creates a Project and gives a Group the Role admin in it",
        async () => {
          const uiSession = await openAdminUi("/projects");
          const { page } = uiSession;
          await page.getByLabel("Project name").fill(projectName);
          await page.getByRole("button", { name: "Create Project" }).click();
          await page.getByRole("heading", { name: projectName, level: 1 }).waitFor();
          projectPath = new URL(page.url()).pathname;
          assertMatch(projectPath, /^\/projects\/[0-9a-f-]{36}$/);
          await page.getByText("No Group has a Role in this Project yet.").waitFor();

          await page.getByLabel("Group", { exact: true }).selectOption({ label: "Administrators" });
          await page.getByLabel("Role for the Group").selectOption("admin");
          await page.getByRole("button", { name: "Assign Role" }).click();
          await page.getByLabel("Role of Administrators", { exact: true }).waitFor();
          assertEquals(
            await page.getByLabel("Role of Administrators", { exact: true }).inputValue(),
            "admin",
          );

          // The administrator is in the Group, so the new Project is theirs to switch to.
          await page.locator(".project-switcher-trigger").click();
          await page.getByRole("button", { name: new RegExp(`^${projectName}`) }).click();
          assertEquals(
            (await page.locator(".project-switcher-name").innerText()).trim(),
            projectName,
          );
          await page.getByRole("link", { name: "Traces" }).click();
          await page.getByText("No traces yet").waitFor();
          assertNoPageErrors(uiSession);
          await uiSession.close();
        },
      );

      await testContext.step("creates an API key that is shown once", async () => {
        const uiSession = await openAdminUi(projectPath);
        const { page } = uiSession;
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
        const tracesResponse = await fetch(`${deployment.gatewayUrl}/v1/traces`, {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        assertEquals(tracesResponse.status, 200);
        await tracesResponse.body?.cancel();
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

      await testContext.step("creates a user and a Group with the user in it", async () => {
        const uiSession = await openAdminUi("/access");
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Access", level: 1 }).waitFor();
        await page.getByLabel("Email").fill(viewer.email);
        await page.getByLabel("Name", { exact: true }).fill(`Viewer ${uniquePart}`);
        await page.getByLabel("Initial password").fill(viewer.password);
        await page.getByRole("button", { name: "Create user" }).click();
        await page.locator(".user-email", { hasText: viewer.email }).waitFor();

        await page.getByLabel("New Group's name").fill(groupName);
        await page.getByRole("button", { name: "Create Group" }).click();
        const group = page.getByRole("listitem", { name: `Group ${groupName}` });
        await group.waitFor();
        await group.getByLabel(`User to add to ${groupName}`).selectOption({
          label: `Viewer ${uniquePart} (${viewer.email})`,
        });
        await group.getByRole("button", { name: "Add member" }).click();
        await group.getByRole("list", { name: `Members of ${groupName}` }).waitFor();
        assertEquals(await group.locator(".member-chip-name").allInnerTexts(), [
          `Viewer ${uniquePart}`,
        ]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("lets a viewer read prompts but offers no changes", async () => {
        const adminSession = await openAdminUi(projectPath);
        await adminSession.page.getByLabel("Group", { exact: true }).selectOption({
          label: groupName,
        });
        await adminSession.page.getByLabel("Role for the Group").selectOption("viewer");
        await adminSession.page.getByRole("button", { name: "Assign Role" }).click();
        await adminSession.page.getByLabel(`Role of ${groupName}`, { exact: true }).waitFor();
        await adminSession.close();

        const uiSession = await openUi(openBrowser, deployment, {
          width: 1280,
          account: viewer,
          path: "/prompts",
        });
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Prompts", level: 1 }).waitFor();
        assertEquals(
          (await page.locator(".project-switcher-trigger").innerText()).replace(/\s+/g, " ").trim(),
          `${projectName} viewer`,
        );
        await page.getByText("No prompts yet").waitFor();
        assertEquals(await page.getByRole("link", { name: "New prompt" }).count(), 0);
        assertEquals(await page.getByRole("link", { name: "Access" }).count(), 0);
        await page.getByRole("link", { name: "Projects" }).click();
        assertEquals(await page.locator(".project-cell-name").allInnerTexts(), [projectName]);
        await page.getByRole("link", { name: projectName }).click();
        await page.getByText("Only the Project's admins manage its Roles and API keys.").waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      for (
        const [pageName, path] of [
          ["Project list", "/projects"],
          ["Project", "PROJECT"],
          ["Access", "/access"],
        ]
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
        const uiSession = await openAdminUi("/projects", 360);
        const { page } = uiSession;
        await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
        const topBarHeight = await page.locator(".top-bar").evaluate((element) =>
          element.getBoundingClientRect().height
        );
        assertEquals(Math.round(topBarHeight), 52);
        // On a phone the sections sit behind the menu button, which still marks the current one.
        await page.getByRole("button", { name: "Show sections" }).click();
        assertEquals(
          await page.getByRole("navigation", { name: "Sections" })
            .getByRole("link", { name: "Projects" }).getAttribute("aria-current"),
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
        assert(!(await page.locator(".project-switcher-name").innerText()).includes(projectName));
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
