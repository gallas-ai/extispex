/**
 * The company's directory through the Gateway: a SCIM client creates users and Company groups,
 * a mapped Company group moves people into a Group, deactivation ends that, and a CSV file does the
 * same for a company without SCIM. The browser part drives the Access page's Directory sync panel
 * and checks that it never scrolls sideways.
 */
import { Buffer } from "node:buffer";
import { assert, assertEquals } from "@std/assert";
import type {
  CreatedDirectoryToken,
  DirectoryImportSummary,
  Group,
  ListUsersResponse,
} from "@extispex/contracts";
import type { Browser } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  forgetExpectedRequestFailures,
  launchBrowser,
  openUi,
} from "./browser.ts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";
import { callGateway, type SignedInUser, signInThroughGateway } from "./sign-in.ts";

/** Every window width the layout must fit without scrolling sideways, phone to wide monitor. */
const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);

interface ScimResource {
  id: string;
  [attributeName: string]: unknown;
}

async function callScim<ResponseBody>(
  deployment: RunningDeployment,
  directoryToken: string,
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown,
): Promise<ResponseBody> {
  const response = await fetch(`${deployment.gatewayUrl}/scim/v2${path}`, {
    method,
    headers: {
      authorization: `Bearer ${directoryToken}`,
      ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseText = await response.text();
  assertEquals(response.status, expectedStatus, `${method} ${path}: ${responseText}`);
  return (responseText === "" ? null : JSON.parse(responseText)) as ResponseBody;
}

async function readMemberEmails(
  deployment: RunningDeployment,
  admin: SignedInUser,
  groupId: string,
): Promise<string[]> {
  const { groups } = await callGateway<{ groups: Group[] }>(deployment, "GET", "/v1/groups", 200, {
    bearerToken: admin.accessToken,
  });
  return groups.find((group) => group.id === groupId)!.members.map((member) => member.email);
}

async function createMappedGroup(
  deployment: RunningDeployment,
  admin: SignedInUser,
  name: string,
  companyGroup: string,
): Promise<Group> {
  const group = await callGateway<Group>(deployment, "POST", "/v1/groups", 201, {
    bearerToken: admin.accessToken,
    body: { name },
  });
  await callGateway(deployment, "PUT", `/v1/groups/${group.id}/company-groups`, 200, {
    bearerToken: admin.accessToken,
    body: { companyGroups: [companyGroup] },
  });
  return group;
}

Deno.test({
  name: "directory sync through the gateway",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    // Fresh names keep the test apart from data that other runs leave in a shared database.
    const uniquePart = crypto.randomUUID().slice(0, 8);
    try {
      const admin = await signInThroughGateway(deployment, deployment.admin);
      const directoryToken = await callGateway<CreatedDirectoryToken>(
        deployment,
        "POST",
        "/v1/directory/tokens",
        201,
        { bearerToken: admin.accessToken, body: { name: `e2e directory ${uniquePart}` } },
      );

      await testContext.step("syncs users and Company groups over SCIM", async () => {
        const userName = `scim-${uniquePart}@e2e.extispex.test`;
        const companyGroup = `e2e-scim-${uniquePart}`;
        const group = await createMappedGroup(
          deployment,
          admin,
          `SCIM engineers ${uniquePart}`,
          companyGroup,
        );
        const user = await callScim<ScimResource>(
          deployment,
          directoryToken.token,
          "POST",
          "/Users",
          201,
          { userName, displayName: "SCIM Person", active: true },
        );
        await callScim(deployment, directoryToken.token, "POST", "/Groups", 201, {
          displayName: companyGroup,
          members: [{ value: user.id }],
        });
        assertEquals(await readMemberEmails(deployment, admin, group.id), [userName]);

        await callScim(deployment, directoryToken.token, "PATCH", `/Users/${user.id}`, 200, {
          Operations: [{ op: "Replace", path: "active", value: "False" }],
        });
        assertEquals(await readMemberEmails(deployment, admin, group.id), []);
        const { users } = await callGateway<ListUsersResponse>(
          deployment,
          "GET",
          "/v1/users",
          200,
          {
            bearerToken: admin.accessToken,
          },
        );
        const deactivatedUser = users.find((candidate) => candidate.email === userName)!;
        assert(deactivatedUser.deactivatedAt !== null);
        assertEquals(deactivatedUser.directorySource, "scim");

        const response = await fetch(`${deployment.gatewayUrl}/scim/v2/Users`, {
          headers: { authorization: `Bearer ${admin.accessToken}` },
        });
        assertEquals(response.status, 401, "A user's access token is not a directory token.");
        await response.body?.cancel();
      });

      await testContext.step("imports a CSV file", async () => {
        const companyGroup = `e2e-csv-${uniquePart}`;
        const group = await createMappedGroup(
          deployment,
          admin,
          `CSV engineers ${uniquePart}`,
          companyGroup,
        );
        const email = `csv-${uniquePart}@e2e.extispex.test`;
        const response = await fetch(`${deployment.gatewayUrl}/v1/directory/imports`, {
          method: "POST",
          headers: { authorization: `Bearer ${admin.accessToken}`, "content-type": "text/csv" },
          body: `email,displayName,companyGroups\n${email},CSV Person,${companyGroup}\n`,
        });
        const summary = await response.json() as DirectoryImportSummary;
        assertEquals(response.status, 200, JSON.stringify(summary));
        assertEquals([summary.format, summary.createdCount], ["csv", 1]);
        assertEquals(await readMemberEmails(deployment, admin, group.id), [email]);
      });

      browser = await launchBrowser();
      const openBrowser = browser;

      await testContext.step(
        "imports a file and maps a Company group on the Access page",
        async () => {
          const companyGroup = `e2e-ui-${uniquePart}`;
          const groupName = `UI directory ${uniquePart}`;
          await callGateway(deployment, "POST", "/v1/groups", 201, {
            bearerToken: admin.accessToken,
            body: { name: groupName },
          });
          const uiSession = await openUi(openBrowser, deployment, {
            width: 1280,
            account: deployment.admin,
            path: "/access",
          });
          const { page } = uiSession;
          const panel = page.getByRole("region", { name: "Directory sync" });
          await panel.waitFor();
          assertEquals(
            await panel.locator(".scim-url .new-api-key-secret").innerText(),
            `${deployment.gatewayUrl}/scim/v2`,
          );

          await panel.getByLabel("New token's name").fill(`UI token ${uniquePart}`);
          await panel.getByRole("button", { name: "Create token" }).click();
          const tokenValue = await panel.getByRole("status", { name: "New directory token" })
            .locator(".new-api-key-secret").innerText();
          assert(tokenValue.startsWith("extispex_"));

          await panel.getByLabel("CSV or JSON file").setInputFiles({
            name: "people.csv",
            mimeType: "text/csv",
            buffer: Buffer.from(
              `email;displayName;companyGroups\nui-${uniquePart}@e2e.extispex.test;UI Person;` +
                `${companyGroup}\nnot-an-email;Somebody;\n`,
            ),
          });
          await panel.getByRole("button", { name: "Import file" }).click();
          await panel.getByText("Row 3: email: Invalid email address").waitFor();

          await panel.getByLabel("CSV or JSON file").setInputFiles({
            name: "people.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({
              users: [{
                email: `ui-${uniquePart}@e2e.extispex.test`,
                displayName: "UI Person",
                companyGroups: [companyGroup],
              }],
            })),
          });
          await panel.getByRole("button", { name: "Import file" }).click();
          await panel.getByText("Imported: 1 created, 0 updated, 0 deactivated, 0 unchanged.")
            .waitFor();

          const item = panel.getByRole("listitem", { name: `Company group ${companyGroup}` });
          await item.getByLabel(`Group for ${companyGroup}`).selectOption({ label: groupName });
          await item.getByRole("button", { name: "Map to Group" }).click();
          await item.getByRole("list", { name: `Groups that ${companyGroup} joins` }).waitFor();
          const group = page.getByRole("listitem", { name: `Group ${groupName}` });
          await group.getByRole("list", { name: `Members of ${groupName}` }).waitFor();
          assertEquals(await group.locator(".member-chip-name").allInnerTexts(), ["UI Person"]);

          await item.getByRole("button", { name: `Unmap ${companyGroup} from ${groupName}` })
            .click();
          await item.getByRole("list", { name: `Groups that ${companyGroup} joins` }).waitFor({
            state: "detached",
          });
          await group.getByRole("list", { name: `Members of ${groupName}` }).waitFor({
            state: "detached",
          });
          // The refused file is an expected 400.
          forgetExpectedRequestFailures(uiSession, [400]);
          assertNoPageErrors(uiSession);
          await uiSession.close();
        },
      );

      await testContext.step("never scrolls the Access page sideways", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 360,
          account: deployment.admin,
          path: "/access",
        });
        const { page } = uiSession;
        await page.getByRole("region", { name: "Directory sync" }).waitFor();
        for (const width of SWEPT_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await assertNoHorizontalOverflow(page, `on the Access page at ${width}px`);
        }
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });
    } finally {
      await browser?.close();
      await deployment.stop();
    }
  },
});
