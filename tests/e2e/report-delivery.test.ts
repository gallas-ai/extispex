/**
 * Reports of finished runs through the Gateway: delivered to an SMTP server and a Teams webhook
 * that run inside this test process, and their settings and delivery status in the web UI.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  EvaluationRunSummary,
  EvaluationRunWork,
  IterationReport,
  ListReportDeliveriesResponse,
  ReportSettings,
} from "@extispex/contracts";
import { readEmail, startFakeSmtpServer } from "@extispex/service-runtime/fake-smtp-server";
import type { Browser, Page } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  launchBrowser,
  openUi,
  waitForCondition,
} from "./browser.ts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";
import { callGateway } from "./sign-in.ts";

const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);
const SMTP_PASSWORD = "e2e-smtp-password";
const WEBHOOK_SECRET = "e2e-webhook-signature";

interface FakeWebhook {
  url: string;
  messages: { attachments: { content: { actions: { url: string }[]; body: unknown[] } }[] }[];
  stop(): Promise<void>;
}

/** Stands in for a Teams Workflows webhook, which answers 202 Accepted. */
function startFakeWebhook(): FakeWebhook {
  const messages: FakeWebhook["messages"] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      messages.push(await request.json());
      return new Response(null, { status: 202 });
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}/workflows/report?sig=${WEBHOOK_SECRET}`,
    messages,
    stop: () => server.shutdown(),
  };
}

/** Runs a Dataset of two Test Cases from a script, `refund` failing, and waits for its end. */
async function runDatasetWithOneFailure(
  deployment: RunningDeployment,
  datasetName: string,
): Promise<string> {
  const bearerToken = deployment.apiKey;
  const work = await callGateway<EvaluationRunWork>(
    deployment,
    "POST",
    "/v1/evaluation-runs",
    201,
    {
      bearerToken,
      body: { datasetName, executionMode: "client" },
    },
  );
  const reports: IterationReport[] = work.items.map((item) => ({
    iterationId: item.iterationId,
    attempt: item.attempt,
    output: item.testCaseName === "refund" ? "No refunds, sorry." : "Hello there!",
    correlationId: `e2e-report-${item.iterationId}`,
  }));
  await callGateway(deployment, "POST", `/v1/evaluation-runs/${work.runId}/reports`, 200, {
    bearerToken,
    body: { reports },
  });
  await waitForCondition("the run finished", async () => {
    const run = await callGateway<EvaluationRunSummary>(
      deployment,
      "GET",
      `/v1/evaluation-runs/${work.runId}`,
      200,
      { bearerToken },
    );
    return run.status === "finished";
  }, 30_000);
  return work.runId;
}

async function sweepWidths(page: Page, label: string): Promise<void> {
  for (const width of SWEPT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await assertNoHorizontalOverflow(page, `on ${label} at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

Deno.test({
  name: "Reports through the gateway",
  // A container has its own network, so it cannot reach an SMTP server on this machine.
  ignore: Deno.env.get("E2E_DEPLOYMENT") === "external",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    const smtpServer = startFakeSmtpServer();
    const webhook = startFakeWebhook();
    let browser: Browser | null = null;
    const bearerToken = deployment.apiKey;
    const uniquePart = crypto.randomUUID().slice(0, 8);
    const datasetName = `e2e-reports-${uniquePart}`;
    try {
      await callGateway(deployment, "POST", "/v1/datasets", 201, {
        bearerToken,
        body: { name: datasetName },
      });
      for (const [name, pattern] of [["refund", "30 days"], ["greeting", "Hello"]]) {
        await callGateway(deployment, "POST", `/v1/datasets/${datasetName}/test-cases`, 201, {
          bearerToken,
          body: {
            name,
            input: { message: name },
            evaluators: [{ type: "regex", name: "expected-words", pattern }],
          },
        });
      }

      await testContext.step("delivers a finished run's Report by email and to Teams", async () => {
        const settings = await callGateway<ReportSettings>(
          deployment,
          "PUT",
          "/v1/report-settings",
          200,
          {
            bearerToken,
            body: {
              condition: "on_failure",
              email: {
                smtpHost: smtpServer.hostName,
                smtpPort: smtpServer.port,
                smtpSecurity: "none",
                smtpUsername: "reports",
                smtpPassword: SMTP_PASSWORD,
                fromAddress: "extispex@e2e.extispex.test",
                recipients: ["team@e2e.extispex.test"],
              },
              teams: { webhookUrl: webhook.url },
            },
          },
        );
        assert(!JSON.stringify(settings).includes(SMTP_PASSWORD));
        assert(!JSON.stringify(settings).includes(WEBHOOK_SECRET));

        const runId = await runDatasetWithOneFailure(deployment, datasetName);
        const [email] = await smtpServer.waitForEmails(1);
        assertEquals(email.envelopeRecipients, ["team@e2e.extispex.test"]);
        assertEquals(email.signedInAs, { username: "reports", password: SMTP_PASSWORD });
        const { headers, parts } = readEmail(email.rawMessage);
        assertEquals(headers.get("subject"), `[Extispex] Evaluation Run failed: ${datasetName}`);
        const text = parts.find((part) => part.contentType === "text/plain")!.body;
        assertStringIncludes(text, "Test Cases: 1 passed, 1 failed, of 2");
        assertStringIncludes(text, "- refund: failed, 0 of 1 Iterations passed");
        assertStringIncludes(text, `/evaluation-runs/${runId}?project=`);
        assert(parts.some((part) => part.contentType === "text/html"));

        await waitForCondition(
          "the webhook got the Report",
          () => Promise.resolve(webhook.messages.length === 1),
          30_000,
        );
        const card = webhook.messages[0].attachments[0].content;
        assertStringIncludes(card.actions[0].url, `/evaluation-runs/${runId}?project=`);
        assertStringIncludes(JSON.stringify(card.body), `Evaluation Run failed: ${datasetName}`);

        await waitForCondition("both deliveries are recorded", async () => {
          const { reportDeliveries } = await callGateway<ListReportDeliveriesResponse>(
            deployment,
            "GET",
            `/v1/evaluation-runs/${runId}/report-deliveries`,
            200,
            { bearerToken },
          );
          return reportDeliveries.length === 2 &&
            reportDeliveries.every((delivery) => delivery.status === "delivered");
        }, 30_000);
      });

      await testContext.step("changes Report settings in the web UI", async () => {
        browser = await launchBrowser();
        const uiSession = await openUi(browser, deployment, {
          width: 1440,
          account: deployment.admin,
          path: "/evaluation-runs",
        });
        const { page } = uiSession;
        await page.getByRole("link", { name: "Report settings" }).click();
        await page.getByRole("heading", { name: "Report settings", level: 1 }).waitFor();
        assertEquals(await page.getByLabel("SMTP host").inputValue(), smtpServer.hostName);
        assertStringIncludes(
          await page.locator(".report-settings-form").innerText(),
          `A webhook URL on 127.0.0.1:${new URL(webhook.url).port} is stored encrypted.`,
        );
        await page.getByRole("radio", { name: "Every finished run" }).click();
        await page.getByLabel("Recipients").fill("team@e2e.extispex.test\nlead@e2e.extispex.test");
        await sweepWidths(page, "the Report settings");
        await page.getByRole("button", { name: "Save Report settings" }).click();
        await page.getByRole("status").getByText("Saved.").waitFor();
        assert(!(await page.content()).includes(SMTP_PASSWORD));
        const saved = await callGateway<ReportSettings>(
          deployment,
          "GET",
          "/v1/report-settings",
          200,
          { bearerToken },
        );
        assertEquals(saved.condition, "always");
        assertEquals(saved.email?.recipients, ["team@e2e.extispex.test", "lead@e2e.extispex.test"]);
        assertEquals(saved.email?.hasSmtpPassword, true);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("shows the delivery status and the linked Test Case", async () => {
        await runDatasetWithOneFailure(deployment, datasetName);
        const [, email] = await smtpServer.waitForEmails(2);
        assertEquals(email.envelopeRecipients, [
          "team@e2e.extispex.test",
          "lead@e2e.extispex.test",
        ]);
        const text = readEmail(email.rawMessage).parts[0].body;
        const testCaseLink = new URL(/(http\S+testCase=refund)/.exec(text)![1]);
        const uiSession = await openUi(browser!, deployment, {
          width: 1440,
          account: deployment.admin,
          path: `${testCaseLink.pathname}${testCaseLink.search}`,
        });
        const { page } = uiSession;
        const linkedTestCase = page.locator(".linked-test-case");
        await linkedTestCase.getByRole("heading", { name: "refund" }).waitFor();
        await linkedTestCase.locator(".iteration-row").first().waitFor();
        const reports = page.getByRole("region", { name: "Reports" });
        await reports.getByText("Delivered", { exact: true }).nth(1).waitFor({ timeout: 30_000 });
        assertStringIncludes(await reports.innerText(), "Email");
        assertStringIncludes(await reports.innerText(), "Teams");
        await sweepWidths(page, "a run with its Reports");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });
    } finally {
      // The services deployment keeps its database for the next test file.
      await callGateway(deployment, "PUT", "/v1/report-settings", 200, {
        bearerToken,
        body: { condition: "always", email: null, teams: null },
      }).catch(() => {});
      await (browser as Browser | null)?.close();
      await smtpServer.stop();
      await webhook.stop();
      await deployment.stop();
    }
  },
});
