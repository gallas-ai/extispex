/**
 * Rotating the key that signs access tokens, through the Gateway: a new key is published, signs
 * after its publication time, and other services accept tokens from both keys. The browser part
 * drives the Access page's Signing keys panel and checks that it never scrolls sideways.
 */
import { assertEquals } from "@std/assert";
import type { ListSigningKeysResponse, Project, SigningKey } from "@extispex/contracts";
import type { Browser } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  launchBrowser,
  openUi,
  waitForCondition,
} from "./browser.ts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";
import { callGateway, createUserWithRole, signInThroughGateway } from "./sign-in.ts";

const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);

function readKeyId(accessToken: string): string {
  const header = accessToken.split(".")[0].replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(header)).kid;
}

/** Waits until a key may sign: a minute by default, seconds in the e2e deployments. */
async function waitUntilItCanSign(key: SigningKey): Promise<void> {
  const waitMilliseconds = Date.parse(key.canSignFrom) - Date.now() + 500;
  if (waitMilliseconds > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMilliseconds));
  }
}

/**
 * Whether the Prompt service accepts a token. A service reads Identity's keys again for an unknown
 * key ID at most every 30 seconds, so right after a short publication it may need that long.
 */
async function waitUntilPromptAccepts(deployment: RunningDeployment, accessToken: string) {
  await waitForCondition("the Prompt service accepts the token", async () => {
    const response = await fetch(`${deployment.gatewayUrl}/v1/prompts`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await response.body?.cancel();
    return response.status === 200;
  }, 45_000);
}

Deno.test({
  name: "Signing key rotation through the gateway",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    try {
      const admin = await signInThroughGateway(deployment, deployment.admin);
      const project = await callGateway<Project>(deployment, "POST", "/v1/projects", 201, {
        bearerToken: admin.accessToken,
        body: { name: `e2e-signing-${crypto.randomUUID().slice(0, 8)}` },
      });
      // Someone with a Role in the Project, whose tokens the Prompt service checks.
      const { signedIn: viewer } = await createUserWithRole(
        deployment,
        admin,
        project.id,
        "viewer",
      );

      await testContext.step("signs with a new key once it has been published", async () => {
        const tokenBefore = (await viewer.requestProjectToken(project.id)).accessToken;
        const keyBefore = readKeyId(tokenBefore);
        const addedKey = await callGateway<SigningKey>(
          deployment,
          "POST",
          "/v1/signing-keys",
          201,
          { bearerToken: admin.accessToken },
        );
        assertEquals(addedKey.state, "published");
        await waitUntilItCanSign(addedKey);
        await callGateway(
          deployment,
          "POST",
          `/v1/signing-keys/${addedKey.keyId}/activation`,
          200,
          { bearerToken: admin.accessToken },
        );
        const tokenAfter = (await viewer.requestProjectToken(project.id)).accessToken;
        assertEquals(readKeyId(tokenAfter), addedKey.keyId);
        await waitUntilPromptAccepts(deployment, tokenAfter);
        // The retired key stays published, so its tokens work until they expire.
        await waitUntilPromptAccepts(deployment, tokenBefore);
        const { keys } = await callGateway<ListSigningKeysResponse>(
          deployment,
          "GET",
          "/v1/signing-keys",
          200,
          { bearerToken: admin.accessToken },
        );
        assertEquals(keys.find((key) => key.keyId === keyBefore)?.state, "retired");
        assertEquals(keys.find((key) => key.keyId === addedKey.keyId)?.state, "signing");
      });

      browser = await launchBrowser();
      const openBrowser = browser;
      await testContext.step("rotates the key on the Access page", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1280,
          account: deployment.admin,
          path: "/access",
        });
        const { page } = uiSession;
        const panel = page.getByRole("region", { name: "Signing keys" });
        await panel.waitFor();
        const rowsBefore = await panel.locator("tbody tr").count();
        await panel.getByRole("button", { name: "Add key" }).click();
        await waitForCondition(
          "the new key is listed",
          async () => await panel.locator("tbody tr").count() === rowsBefore + 1,
          10_000,
        );
        const newRow = panel.locator("tbody tr").first();
        assertEquals(await newRow.locator("td").nth(1).innerText(), "Published");
        const keyId = await newRow.locator("code").innerText();
        const signButton = panel.getByRole("button", { name: `Sign with ${keyId}` });
        await waitForCondition(
          "the new key can sign",
          async () => await signButton.isEnabled(),
          75_000,
        );
        await signButton.click();
        await waitForCondition(
          "the new key signs",
          async () => (await newRow.locator("td").nth(1).innerText()) === "Signing",
          10_000,
        );
        for (const width of SWEPT_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await assertNoHorizontalOverflow(page, `the Access page at ${width}px`);
        }
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      // The tests after this one share an external deployment. A service that read the keys less
      // than 30 seconds ago reads them again only after that, so give every service the chance.
      if (Deno.env.get("E2E_DEPLOYMENT") === "external") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 31_000));
      }
    } finally {
      await browser?.close();
      await deployment.stop();
    }
  },
});
