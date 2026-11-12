/** Report settings, and Reports of finished runs delivered by email and to Teams. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  ListReportDeliveriesResponse,
  ReportSettings,
  TestCaseResult,
  UpdateReportSettingsRequest,
} from "@extispex/contracts";
import {
  type FakeSmtpServer,
  readEmail,
  startFakeSmtpServer,
} from "@extispex/service-runtime/fake-smtp-server";
import { REPORT_DELIVERY_ATTEMPTS } from "../src/create-service.ts";
import { FAKE_SUMMARY_TEXT } from "./fixtures/fake-llm-provider.ts";
import {
  createDatasetWithTestCases,
  defineEvaluationTest,
  errorReport,
  expectJson,
  outputReport,
  refundTestCase,
  report,
  sendRequest,
  startRun,
  TEST_PUBLIC_UI_URL,
  testAccessTokens,
  type TestHarness,
} from "./evaluation-test-harness.ts";

const SMTP_PASSWORD = "smtp-secret-password";
const WEBHOOK_SIGNATURE = "sig=webhook-secret-signature";

/** Stands in for a Teams Workflows webhook; a test says how it answers. */
interface FakeWebhook {
  url: string;
  messages: unknown[];
  answerStatus: number;
  stop(): Promise<void>;
}

function startFakeWebhook(): FakeWebhook {
  const webhook: FakeWebhook = {
    url: "",
    messages: [],
    answerStatus: 202,
    stop: () => server.shutdown(),
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      webhook.messages.push(await request.json());
      return new Response(webhook.answerStatus < 300 ? null : "Workflow is turned off", {
        status: webhook.answerStatus,
      });
    },
  );
  webhook.url = `http://127.0.0.1:${server.addr.port}/workflows/run?${WEBHOOK_SIGNATURE}`;
  return webhook;
}

function reportSettings(
  smtpServer: FakeSmtpServer,
  webhook: FakeWebhook,
  overrides: Partial<UpdateReportSettingsRequest> = {},
): UpdateReportSettingsRequest {
  return {
    condition: "always",
    email: {
      smtpHost: smtpServer.hostName,
      smtpPort: smtpServer.port,
      smtpSecurity: "none",
      smtpUsername: "reports@company.example",
      smtpPassword: SMTP_PASSWORD,
      fromAddress: "extispex@company.example",
      recipients: ["team@company.example", "lead@company.example"],
    },
    teams: { webhookUrl: webhook.url },
    ...overrides,
  };
}

function saveSettings(harness: TestHarness, settings: UpdateReportSettingsRequest) {
  return expectJson<ReportSettings>(
    sendRequest(harness, "PUT", "/v1/report-settings", { body: settings }),
    200,
  );
}

function listDeliveries(harness: TestHarness, runId: string) {
  return expectJson<ListReportDeliveriesResponse>(
    sendRequest(harness, "GET", `/v1/evaluation-runs/${runId}/report-deliveries`),
    200,
  );
}

/** A run of two Test Cases in which `refund` fails and `greeting` passes. */
async function finishRunWithOneFailure(harness: TestHarness): Promise<string> {
  const work = await startRun(harness);
  const reports = work.items.map((item) =>
    outputReport(item, item.testCaseName === "refund" ? "No refunds." : "Within 30 days.")
  );
  await report(harness, work.runId, reports);
  await harness.drainJobs();
  return work.runId;
}

async function withChannels(
  testBody: (smtpServer: FakeSmtpServer, webhook: FakeWebhook) => Promise<void>,
): Promise<void> {
  const smtpServer = startFakeSmtpServer();
  const webhook = startFakeWebhook();
  try {
    await testBody(smtpServer, webhook);
  } finally {
    await smtpServer.stop();
    await webhook.stop();
  }
}

const TWO_TEST_CASES = [refundTestCase(), refundTestCase({ name: "greeting" })];

defineEvaluationTest("keeps the Report channels' secrets out of every answer", async (harness) => {
  await withChannels(async (smtpServer, webhook) => {
    const defaults = await expectJson<ReportSettings>(
      sendRequest(harness, "GET", "/v1/report-settings"),
      200,
    );
    assertEquals(defaults, { condition: "always", email: null, teams: null, updatedAt: null });

    const saved = await saveSettings(harness, reportSettings(smtpServer, webhook));
    assertEquals(saved.email?.hasSmtpPassword, true);
    assertEquals(saved.email?.recipients, ["team@company.example", "lead@company.example"]);
    assertEquals(saved.teams, { webhookHost: new URL(webhook.url).host });
    const read = await expectJson<ReportSettings>(
      sendRequest(harness, "GET", "/v1/report-settings"),
      200,
    );
    assertEquals(read, saved);
    for (const answer of [saved, read]) {
      assert(!JSON.stringify(answer).includes(SMTP_PASSWORD));
      assert(!JSON.stringify(answer).includes(WEBHOOK_SIGNATURE));
    }
    const [storedRow] = await harness.database.orm.em.fork().execute(
      "select * from report_settings",
    );
    assert(!JSON.stringify(storedRow).includes(SMTP_PASSWORD));
    assert(!JSON.stringify(storedRow).includes(WEBHOOK_SIGNATURE));

    // Leaving the secrets out keeps them.
    const kept = await saveSettings(harness, {
      condition: "on_failure",
      email: { ...reportSettings(smtpServer, webhook).email!, smtpPassword: undefined },
      teams: {},
    });
    assertEquals([kept.condition, kept.email?.hasSmtpPassword, kept.teams], [
      "on_failure",
      true,
      saved.teams,
    ]);

    const otherProject = await expectJson<ReportSettings>(
      sendRequest(harness, "GET", "/v1/report-settings", { bearerToken: "other-project-api-key" }),
      200,
    );
    assertEquals(otherProject.email, null);
  });
});

defineEvaluationTest("refuses Report settings that cannot work", async (harness) => {
  await withChannels(async (smtpServer, webhook) => {
    const settings = reportSettings(smtpServer, webhook);
    const refused = async (body: unknown, expectedMessage: string) => {
      const problem = await expectJson<{ error: { message: string } }>(
        sendRequest(harness, "PUT", "/v1/report-settings", { body }),
        400,
      );
      assertStringIncludes(problem.error.message, expectedMessage);
    };
    await refused(
      { ...settings, email: { ...settings.email, smtpPassword: undefined } },
      "Enter the SMTP password",
    );
    await refused({ ...settings, email: null, teams: {} }, "Enter the Teams webhook URL");
    await refused(
      { ...settings, teams: { webhookUrl: "ftp://teams.example/hook" } },
      "http or https URL",
    );
    await refused({ ...settings, email: { ...settings.email, recipients: [] } }, "recipients");

    const viewerToken = await testAccessTokens.issueAccessToken({
      projectId: "project-one",
      role: "viewer",
    });
    await expectJson(
      sendRequest(harness, "PUT", "/v1/report-settings", {
        body: settings,
        bearerToken: viewerToken,
      }),
      403,
    );
    await expectJson(
      sendRequest(harness, "GET", "/v1/report-settings", { bearerToken: viewerToken }),
      200,
    );
  });
});

defineEvaluationTest("delivers a finished run's Report by email and to Teams", async (harness) => {
  await withChannels(async (smtpServer, webhook) => {
    await createDatasetWithTestCases(harness, TWO_TEST_CASES);
    await saveSettings(harness, reportSettings(smtpServer, webhook));
    const runId = await finishRunWithOneFailure(harness);
    assertEquals(
      harness.queuedJobs.map((job) => job.kind),
      ["deliver-report", "deliver-report"],
    );
    await harness.drainJobs();

    const [email] = smtpServer.receivedEmails;
    assertEquals(email.envelopeRecipients, ["team@company.example", "lead@company.example"]);
    assertEquals(email.signedInAs, {
      username: "reports@company.example",
      password: SMTP_PASSWORD,
    });
    const { headers, parts } = readEmail(email.rawMessage);
    assertEquals(headers.get("subject"), "[Extispex] Evaluation Run failed: support-bot");
    assertEquals(parts.map((part) => part.contentType), ["text/plain", "text/html"]);
    const runUrl = `${TEST_PUBLIC_UI_URL}/evaluation-runs/${runId}?project=project-one`;
    const [text, html] = parts.map((part) => part.body);
    assertStringIncludes(text, "Result: Failed");
    assertStringIncludes(text, "Test Cases: 1 passed, 1 failed, of 2");
    assertStringIncludes(text, "Target: None, run by a script");
    assertStringIncludes(text, "- refund: failed, 0 of 1 Iterations passed");
    assertStringIncludes(text, `${runUrl}&testCase=refund`);
    assertStringIncludes(text, `Open the run: ${runUrl}`);
    assert(!text.includes("LLM Summary"));
    assertStringIncludes(html, `href="${runUrl.replace("&", "&amp;")}&amp;testCase=refund"`);

    const [message] = webhook.messages as {
      attachments: { contentType: string; content: Record<string, unknown> }[];
    }[];
    const card = message.attachments[0];
    assertEquals(card.contentType, "application/vnd.microsoft.card.adaptive");
    assertEquals(card.content.actions, [{
      type: "Action.OpenUrl",
      title: "Open run",
      url: runUrl,
    }]);
    assertStringIncludes(JSON.stringify(card.content.body), "Evaluation Run failed: support-bot");
    assertStringIncludes(JSON.stringify(card.content.body), `[refund](${runUrl}&testCase=refund)`);

    const { reportDeliveries } = await listDeliveries(harness, runId);
    assertEquals(
      reportDeliveries.map(({ channel, status, attempts, lastError, nextAttemptAt }) => ({
        channel,
        status,
        attempts,
        lastError,
        nextAttemptAt,
      })),
      [
        {
          channel: "email",
          status: "delivered",
          attempts: 1,
          lastError: null,
          nextAttemptAt: null,
        },
        {
          channel: "teams",
          status: "delivered",
          attempts: 1,
          lastError: null,
          nextAttemptAt: null,
        },
      ],
    );
    assert(reportDeliveries.every((delivery) => delivery.deliveredAt !== null));

    // A job delivered twice sends nothing twice.
    await harness.worker.handleJob({
      kind: "deliver-report",
      deliveryId: (await harness.database.orm.em.fork().execute(
        "select id from report_deliveries where channel = 'email'",
      ))[0].id,
    });
    assertEquals(smtpServer.receivedEmails.length, 1);

    const testCase = await expectJson<TestCaseResult>(
      sendRequest(harness, "GET", `/v1/evaluation-runs/${runId}/test-cases/refund`),
      200,
    );
    assertEquals([testCase.name, testCase.outcome, testCase.totalIterations], [
      "refund",
      "failed",
      1,
    ]);
    await expectJson(
      sendRequest(harness, "GET", `/v1/evaluation-runs/${runId}/test-cases/missing`),
      404,
    );
    await expectJson(
      sendRequest(harness, "GET", `/v1/evaluation-runs/${runId}/report-deliveries`, {
        bearerToken: "other-project-api-key",
      }),
      404,
    );
  });
});

defineEvaluationTest("waits for the LLM Summary and puts it in the Report", async (harness) => {
  await withChannels(async (smtpServer, webhook) => {
    await createDatasetWithTestCases(harness, TWO_TEST_CASES);
    await saveSettings(harness, reportSettings(smtpServer, webhook));
    await expectJson(
      sendRequest(harness, "POST", "/v1/llm-providers", {
        body: {
          name: "judge",
          kind: "openai_compatible",
          baseUrl: `${harness.llmProvider.url}/v1`,
          defaultModel: "gpt-test",
        },
      }),
      201,
    );
    await expectJson(
      sendRequest(harness, "PUT", "/v1/llm-summary-settings", { body: { providerName: "judge" } }),
      200,
    );
    await finishRunWithOneFailure(harness);
    const jobs = harness.queuedJobs.splice(0);
    harness.queuedDelays.splice(0);
    assertEquals(jobs.map((job) => job.kind), ["summarize", "deliver-report", "deliver-report"]);

    // While the LLM Summary is pending, the Reports wait and look again shortly.
    for (const job of jobs.filter((job) => job.kind === "deliver-report")) {
      await harness.worker.handleJob(job);
    }
    assertEquals(smtpServer.receivedEmails.length, 0);
    assertEquals(harness.queuedDelays, [5_000, 5_000]);
    await harness.worker.runMaintenance();
    assertEquals(harness.queuedJobs.length, 2, "A waiting Report is not stalled.");

    await harness.worker.handleJob(jobs[0]);
    await harness.drainJobs();
    const [text, html] = readEmail(smtpServer.receivedEmails[0].rawMessage).parts.map((part) =>
      part.body
    );
    assertStringIncludes(text.replaceAll("\r\n", "\n"), `LLM Summary:\n${FAKE_SUMMARY_TEXT}`);
    assertStringIncludes(html, FAKE_SUMMARY_TEXT);
    const [message] = webhook.messages as { attachments: { content: { body: unknown } }[] }[];
    // The card escapes Markdown, so the sentence's full stop arrives as `\.`.
    assertStringIncludes(
      JSON.stringify(message.attachments[0].content.body),
      "every Test Case met its expectations",
    );

    // A Report does not wait forever: after five minutes it goes out without the LLM Summary.
    await expectJson(
      sendRequest(harness, "PUT", "/v1/llm-summary-settings", { body: { providerName: "judge" } }),
      200,
    );
    await finishRunWithOneFailure(harness);
    const laterJobs = harness.queuedJobs.splice(0);
    harness.advanceClock(301_000);
    for (const job of laterJobs.filter((job) => job.kind === "deliver-report")) {
      await harness.worker.handleJob(job);
    }
    assertEquals(smtpServer.receivedEmails.length, 2);
    assert(
      !readEmail(smtpServer.receivedEmails[1].rawMessage).parts[0].body.includes("LLM Summary"),
    );
  });
});

defineEvaluationTest("sends a Report only on failure when the Project asks so", async (harness) => {
  await withChannels(async (smtpServer, webhook) => {
    await createDatasetWithTestCases(harness, [refundTestCase()]);
    await saveSettings(harness, reportSettings(smtpServer, webhook, { condition: "on_failure" }));
    const passedRun = await startRun(harness);
    await report(harness, passedRun.runId, [outputReport(passedRun.items[0], "Within 30 days.")]);
    await harness.drainJobsUntilIdle();
    assertEquals((await listDeliveries(harness, passedRun.runId)).reportDeliveries, []);

    // An Error is not a success either, and a run ended early still sends its Report.
    const erroredRun = await startRun(harness);
    await report(harness, erroredRun.runId, [errorReport(erroredRun.items[0])]);
    await expectJson(
      sendRequest(harness, "POST", `/v1/evaluation-runs/${erroredRun.runId}/finish`),
      200,
    );
    await harness.drainJobsUntilIdle();
    const { reportDeliveries } = await listDeliveries(harness, erroredRun.runId);
    assertEquals(reportDeliveries.map((delivery) => delivery.status), ["delivered", "delivered"]);
    const { headers } = readEmail(smtpServer.receivedEmails[0].rawMessage);
    assertEquals(
      headers.get("subject"),
      "[Extispex] Evaluation Run ended with Errors: support-bot",
    );
    assertEquals(smtpServer.receivedEmails.length, 1);
  });
});

defineEvaluationTest("retries a delivery and never changes the run's result", async (harness) => {
  await withChannels(async (smtpServer, webhook) => {
    await createDatasetWithTestCases(harness, TWO_TEST_CASES);
    await saveSettings(harness, reportSettings(smtpServer, webhook));
    smtpServer.queuedRefusals.push("451 4.3.0 Try again later");
    webhook.answerStatus = 500;
    const runId = await finishRunWithOneFailure(harness);
    await harness.drainJobs();

    const afterFirstAttempt = await listDeliveries(harness, runId);
    const [emailDelivery, teamsDelivery] = afterFirstAttempt.reportDeliveries;
    assertEquals([emailDelivery.status, emailDelivery.attempts], ["pending", 1]);
    assertStringIncludes(emailDelivery.lastError ?? "", "451");
    assert(emailDelivery.nextAttemptAt !== null);
    assertStringIncludes(teamsDelivery.lastError ?? "", "status 500: Workflow is turned off");
    // The first retry waits a minute.
    assertEquals(harness.queuedDelays, [60_000, 60_000]);

    await harness.drainJobsUntilIdle();
    const { reportDeliveries } = await listDeliveries(harness, runId);
    assertEquals(reportDeliveries[0].status, "delivered");
    assertEquals(reportDeliveries[0].attempts, 2);
    assertEquals(
      [reportDeliveries[1].status, reportDeliveries[1].attempts, reportDeliveries[1].nextAttemptAt],
      ["failed", REPORT_DELIVERY_ATTEMPTS, null],
    );
    assertEquals(webhook.messages.length, REPORT_DELIVERY_ATTEMPTS);
    const run = await expectJson<{ verdict: string; status: string }>(
      sendRequest(harness, "GET", `/v1/evaluation-runs/${runId}`),
      200,
    );
    assertEquals([run.status, run.verdict], ["finished", "failed"]);
  });
});

defineEvaluationTest("refuses channels outside the allowed destinations", async (harness) => {
  await withChannels(async (smtpServer, webhook) => {
    await createDatasetWithTestCases(harness, TWO_TEST_CASES);
    // The harness allows 127.0.0.1; the name localhost is not on the list.
    const settings = reportSettings(smtpServer, webhook);
    await saveSettings(harness, {
      ...settings,
      email: { ...settings.email!, smtpHost: "localhost" },
      teams: { webhookUrl: webhook.url.replace("127.0.0.1", "localhost") },
    });
    const runId = await finishRunWithOneFailure(harness);
    await harness.drainJobs();
    const { reportDeliveries } = await listDeliveries(harness, runId);
    for (const delivery of reportDeliveries) {
      assertStringIncludes(delivery.lastError ?? "", "EVALUATION_REPORT_ALLOWED_DESTINATIONS");
    }
    assertEquals([smtpServer.receivedEmails.length, webhook.messages.length], [0, 0]);
  });
});

defineEvaluationTest("queues a delivery again when its job was lost", async (harness) => {
  await withChannels(async (smtpServer, webhook) => {
    await createDatasetWithTestCases(harness, TWO_TEST_CASES);
    await saveSettings(harness, reportSettings(smtpServer, webhook, { teams: null }));
    await finishRunWithOneFailure(harness);
    // The job never reaches the worker.
    harness.queuedJobs.splice(0);
    await harness.worker.runMaintenance();
    assertEquals(harness.queuedJobs.length, 0);
    harness.advanceClock(180_000);
    await harness.worker.runMaintenance();
    assertEquals(harness.queuedJobs.map((job) => job.kind), ["deliver-report"]);
    await harness.drainJobs();
    assertEquals(smtpServer.receivedEmails.length, 1);
  });
});

defineEvaluationTest("sends nothing without Report settings", async (harness) => {
  await createDatasetWithTestCases(harness, TWO_TEST_CASES);
  const runId = await finishRunWithOneFailure(harness);
  assertEquals(harness.queuedJobs, []);
  assertEquals((await listDeliveries(harness, runId)).reportDeliveries, []);
});
