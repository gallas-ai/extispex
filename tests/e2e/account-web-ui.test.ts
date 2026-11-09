/**
 * Browser tests of a local account's own password, and of guessing passwords through the Gateway.
 * These run on every deployment, including the all-in-one image.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Project } from "@extispex/contracts";
import type { Browser } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  forgetExpectedRequestFailures,
  launchBrowser,
  openUi,
} from "./browser.ts";
import { startDeployment } from "./deployment.ts";
import { callGateway, createUserWithRole, signInThroughGateway } from "./sign-in.ts";

Deno.test({
  name: "account web UI",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    const uniquePart = crypto.randomUUID().slice(0, 8);
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      const admin = await signInThroughGateway(deployment, deployment.admin);
      const project = await callGateway<Project>(deployment, "POST", "/v1/projects", 201, {
        bearerToken: admin.accessToken,
        body: { name: `e2e-account-${uniquePart}` },
      });
      const { account } = await createUserWithRole(deployment, admin, project.id, "viewer");

      await testContext.step("changes the user's own password", async () => {
        const uiSession = await openUi(openBrowser, deployment, { width: 360, account });
        const { page } = uiSession;
        await page.locator(".user-menu-trigger").click();
        await page.getByRole("link", { name: "Change password" }).click();
        await page.getByRole("heading", { name: "Account", level: 1 }).waitFor();
        await assertNoHorizontalOverflow(page, "on the account page");

        await page.getByLabel("Current password").fill("not-the-password");
        await page.getByLabel("New password").fill("a-new-long-password");
        await page.getByRole("button", { name: "Change password" }).click();
        assertStringIncludes(
          await page.locator(".account-form [role=alert]").innerText(),
          "current password is wrong",
        );
        forgetExpectedRequestFailures(uiSession, [403]);

        await page.getByLabel("Current password").fill(account.password);
        await page.getByRole("button", { name: "Change password" }).click();
        await page.getByRole("status").waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();

        await signInThroughGateway(deployment, {
          email: account.email,
          password: "a-new-long-password",
        });
      });

      await testContext.step("stops guessing a password through the Gateway", async () => {
        const guess = async () => {
          const response = await fetch(`${deployment.gatewayUrl}/v1/sign-in`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: account.email, password: "not-the-password" }),
          });
          await response.body?.cancel();
          return response;
        };
        for (let guessNumber = 1; guessNumber <= 10; guessNumber++) {
          assertEquals((await guess()).status, 401);
        }
        const blocked = await guess();
        assertEquals(blocked.status, 429);
        assertEquals(Number(blocked.headers.get("retry-after")) > 0, true);
      });
    } finally {
      await browser?.close();
      await deployment.stop();
    }
  },
});
