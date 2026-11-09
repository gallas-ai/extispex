/**
 * Signing in through a real identity provider. Needs Keycloak with the realm in
 * `tests/e2e/keycloak`, whose address is in `E2E_OIDC_ISSUER_URL`; CI starts it for the all-in-one
 * and services deployments. Keycloak's address differs from the Gateway's, so the redirect back is
 * a cross-site navigation, as it is in production.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessTokenResponse, Group, Project, SignInOptions } from "@extispex/contracts";
import type { Browser } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  forgetExpectedRequestFailures,
  launchBrowser,
  openUi,
} from "./browser.ts";
import { startDeployment } from "./deployment.ts";
import { callGateway, signInThroughGateway } from "./sign-in.ts";

const COMPANY_GROUP = "e2e-engineering";
const PERSON_AT_PROVIDER = { username: "ada", password: "ada-e2e-password" };

Deno.test({
  name: "OIDC sign-in through Keycloak",
  ignore: !Deno.env.get("E2E_OIDC_ISSUER_URL"),
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
        body: { name: `e2e-oidc-${uniquePart}` },
      });
      const group = await callGateway<Group>(deployment, "POST", "/v1/groups", 201, {
        bearerToken: admin.accessToken,
        body: { name: `OIDC engineers ${uniquePart}` },
      });
      await callGateway(
        deployment,
        "PUT",
        `/v1/projects/${project.id}/role-assignments/${group.id}`,
        200,
        { bearerToken: admin.accessToken, body: { role: "editor" } },
      );

      await testContext.step("tells the UI that the provider is available", async () => {
        const response = await fetch(`${deployment.gatewayUrl}/v1/sign-in/options`);
        assertEquals(await response.json() as SignInOptions, {
          areLocalAccountsEnabled: true,
          oidcProviderName: "Keycloak",
        });
      });

      await testContext.step("maps a Company group to a Group on the Access page", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1280,
          account: deployment.admin,
          path: "/access",
        });
        const { page } = uiSession;
        const companyGroups = page.getByLabel(
          `Company groups whose members join ${group.name}, one per line`,
        );
        await companyGroups.fill(COMPANY_GROUP);
        await Promise.all([
          page.waitForResponse((response) =>
            response.url().includes(`/v1/groups/${group.id}/company-groups`) && response.ok()
          ),
          page.getByRole("listitem", { name: `Group ${group.name}` })
            .getByRole("button", { name: "Save Company groups" }).click(),
        ]);
        const { groups } = await callGateway<{ groups: Group[] }>(
          deployment,
          "GET",
          "/v1/groups",
          200,
          { bearerToken: admin.accessToken },
        );
        assertEquals(
          groups.find((candidate) => candidate.id === group.id)?.companyGroups,
          [COMPANY_GROUP],
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("signs in at the provider and gets the Group's Role", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 360,
          account: null,
          path: "/projects",
        });
        const { page } = uiSession;
        await page.getByRole("link", { name: "Sign in with Keycloak" }).waitFor();
        await assertNoHorizontalOverflow(page, "on the sign-in page with a provider");
        await page.getByRole("link", { name: "Sign in with Keycloak" }).click();

        await page.locator("#username").fill(PERSON_AT_PROVIDER.username);
        await page.locator("#password").fill(PERSON_AT_PROVIDER.password);
        await page.locator("#kc-login").click();

        // Back on the page that the sign-in started from, signed in.
        await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
        assertEquals(new URL(page.url()).pathname, "/projects");
        const tokenResponse = await page.context().request.post("/v1/sign-in/access-tokens", {
          data: { projectId: project.id },
        });
        assertEquals(tokenResponse.status(), 200, await tokenResponse.text());
        assertEquals((await tokenResponse.json() as AccessTokenResponse).role, "editor");
        await page.getByRole("link", { name: project.name }).waitFor();
        forgetExpectedRequestFailures(uiSession, [401]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("adds only the mapped Company group's Group", async () => {
        const { groups } = await callGateway<{ groups: Group[] }>(
          deployment,
          "GET",
          "/v1/groups",
          200,
          { bearerToken: admin.accessToken },
        );
        const members = groups.find((candidate) => candidate.id === group.id)!.members;
        assertEquals(
          members.map(({ email, displayName, isFromCompanyGroup }) => ({
            email,
            displayName,
            isFromCompanyGroup,
          })),
          [{
            email: "ada@e2e.extispex.test",
            displayName: "Ada Lovelace",
            isFromCompanyGroup: true,
          }],
        );
      });

      await testContext.step("explains a failed sign-in on the sign-in page", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1280,
          account: null,
          path: "/v1/sign-in/oidc/callback?code=forged&state=forged",
        });
        const { page } = uiSession;
        assertStringIncludes(
          await page.locator(".sign-in-failure").innerText(),
          "took too long or was already used",
        );
        assertEquals(new URL(page.url()).search, "");
        forgetExpectedRequestFailures(uiSession, [401]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });
    } finally {
      await browser?.close();
      await deployment.stop();
    }
  },
});
