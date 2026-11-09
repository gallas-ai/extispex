/**
 * Browser tests of the Logs page: searching and filtering, a record's details, the way to its
 * trace and back, the rejected counts, and the layout rules that keep the page from scrolling
 * sideways.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Browser, Page } from "playwright-core";
import {
  assertNoPageErrors,
  launchBrowser,
  measureHorizontalOverflow,
  openUi,
  waitForCondition,
} from "./browser.ts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";

const LOG_TRACE_ID = crypto.randomUUID().replaceAll("-", "");
const LOG_SPAN_ID = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
/** Every window width the layout must fit without scrolling sideways, phone to wide monitor. */
const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);
const PAGED_RECORD_COUNT = 105;
const FIRST_PAGE_SIZE = 100;

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

interface SeededLogs {
  /** A word that only the trace's log record contains. */
  traceWord: string;
  /** A word that only the record with a very long body contains. */
  longBodyWord: string;
  /** The service whose records take more than one page. */
  pagedServiceName: string;
  rootSpanName: string;
}

Deno.test({
  name: "logs web UI",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      const seededLogs = await seedLogs(deployment);
      const openAdminUi = (path: string, width = 1280) =>
        openUi(openBrowser, deployment, { width, account: deployment.admin, path });
      const searchPath = (word: string) => `/logs?search=${encodeURIComponent(word)}`;

      await testContext.step("opens from the navigation and lists log records", async () => {
        const uiSession = await openAdminUi("/traces");
        const { page } = uiSession;
        await page.getByRole("link", { name: "Logs" }).click();
        await page.getByRole("heading", { name: "Logs", level: 1 }).waitFor();
        await page.locator(".log-row").first().waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("searches by a word and keeps the search in the link", async () => {
        const uiSession = await openAdminUi("/logs");
        const { page } = uiSession;
        await page.locator(".log-row").first().waitFor();
        await page.getByPlaceholder("Search words in the message").fill(seededLogs.traceWord);
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await waitForRowCount(page, 1);
        assertStringIncludes(page.url(), `search=${seededLogs.traceWord}`);
        await page.reload();
        await waitForRowCount(page, 1);
        assertStringIncludes(await page.locator(".log-message").innerText(), seededLogs.traceWord);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("explains an empty result and clears the filters", async () => {
        const uiSession = await openAdminUi(searchPath("wordthatnologcontains"));
        const { page } = uiSession;
        await page.getByRole("heading", { name: "No log records match these filters" }).waitFor();
        await page.locator(".empty-state").getByRole("button", { name: "Clear filters" }).click();
        await page.locator(".log-row").first().waitFor();
        assertEquals(page.url().includes("search="), false);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("filters by severity and by an attribute", async () => {
        const uiSession = await openAdminUi(searchPath(seededLogs.traceWord));
        const { page } = uiSession;
        await waitForRowCount(page, 1);
        await page.getByLabel("Severity").selectOption("fatal");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("heading", { name: "No log records match these filters" }).waitFor();
        await page.getByLabel("Severity").selectOption("warn");

        // The browser refuses a value that is not key=value, so the search does not change.
        const attributeField = page.getByPlaceholder("Attribute: key=value");
        await attributeField.fill("no-equals-sign");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        assertEquals(page.url().includes("attribute="), false);

        await attributeField.fill("gen_ai.request.model=model-one");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await waitForRowCount(page, 1);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("opens a record and goes to its trace and span", async () => {
        const uiSession = await openAdminUi(searchPath(seededLogs.traceWord));
        const { page } = uiSession;
        await waitForRowCount(page, 1);
        await page.locator(".log-row").click();
        assertStringIncludes(await page.locator(".log-detail-body").innerText(), "Payment failed");
        await page.getByRole("link", { name: "Open trace" }).click();
        await page.locator(".trace-detail-panel").getByRole("heading", {
          name: seededLogs.rootSpanName,
          level: 2,
        }).waitFor();
        assertStringIncludes(page.url(), `traceId=${LOG_TRACE_ID}`);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("shows a trace's logs in order and leads to their spans", async () => {
        const uiSession = await openAdminUi(`/traces?traceId=${LOG_TRACE_ID}`);
        const { page } = uiSession;
        const traceLogs = page.getByRole("region", { name: "Logs of this trace" });
        await traceLogs.getByRole("heading", { name: "Logs (2)" }).waitFor();
        const messages = await traceLogs.locator(".trace-log-message").allInnerTexts();
        assertStringIncludes(messages[0], "Calling the model");
        assertStringIncludes(messages[1], seededLogs.traceWord);
        await traceLogs.locator(".trace-log-button").last().click();
        await waitForCondition(
          "the record's span is selected",
          () => Promise.resolve(page.url().includes(`spanId=${LOG_SPAN_ID}`)),
        );
        await traceLogs.getByRole("link", { name: "Open in Logs" }).click();
        await waitForRowCount(page, 2);
        assertStringIncludes(page.url(), `traceId=${LOG_TRACE_ID}`);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("loads older records page by page", async () => {
        const uiSession = await openAdminUi(
          `/logs?serviceName=${encodeURIComponent(seededLogs.pagedServiceName)}`,
        );
        const { page } = uiSession;
        await waitForRowCount(page, FIRST_PAGE_SIZE);
        await page.getByRole("button", { name: "Load older records" }).click();
        await waitForRowCount(page, PAGED_RECORD_COUNT);
        assertEquals(await page.getByRole("button", { name: "Load older records" }).count(), 0);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("tells how many spans and log records were rejected", async () => {
        const uiSession = await openAdminUi("/logs");
        const { page } = uiSession;
        const logNotice = page.locator(".rejected-telemetry-notice");
        await logNotice.waitFor();
        assertStringIncludes(await logNotice.innerText(), "rejected in the last 24 hours");
        assertStringIncludes(await logNotice.innerText(), "correlation.id");
        await page.goto("/traces");
        await logNotice.waitFor();
        assertStringIncludes(await logNotice.innerText(), "span");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      for (
        const [width, expectedColumns] of [
          [1280, ["time", "severity", "service", "message"]],
          [800, ["time", "severity", "message"]],
          [400, ["time", "severity", "message"]],
        ] as const
      ) {
        await testContext.step(`shows the right columns at ${width}px`, async () => {
          const uiSession = await openAdminUi("/logs", width);
          const { page } = uiSession;
          await page.locator(".log-row").first().waitFor();
          assertEquals(await readVisibleColumnHeadings(page), [...expectedColumns]);
          // A hidden column must leave its room to the message, also with a record open.
          await page.locator(".log-row").first().click();
          await page.locator(".log-detail").waitFor();
          const tableWidth = await page.locator(".log-table").evaluate((element) =>
            element.getBoundingClientRect().width
          );
          const messageRight = await page.locator("thead th").last().evaluate((element) =>
            element.getBoundingClientRect().right
          );
          const tableRight = await page.locator(".log-table").evaluate((element) =>
            element.getBoundingClientRect().right
          );
          assert(tableWidth > 0);
          assertEquals(Math.round(messageRight), Math.round(tableRight));
          assertNoPageErrors(uiSession);
          await uiSession.close();
        });
      }

      await testContext.step("never scrolls sideways, even with a very long record", async () => {
        const uiSession = await openAdminUi(searchPath(seededLogs.longBodyWord));
        const { page } = uiSession;
        await waitForRowCount(page, 1);
        await page.locator(".log-row").click();
        await page.locator(".log-detail-body").waitFor();
        for (const width of SWEPT_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          assertEquals(
            await measureHorizontalOverflow(page.locator("html")),
            0,
            `The page scrolls sideways at ${width}px.`,
          );
          assertEquals(
            await measureHorizontalOverflow(page.locator(".log-list-panel .table-scroll")),
            0,
            `The log list scrolls sideways at ${width}px.`,
          );
          const detailWidth = await page.locator(".log-detail").evaluate((element) =>
            element.getBoundingClientRect().width
          );
          assert(detailWidth > 0, `The record's details have no width at ${width}px.`);
        }
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("fits a trace's logs in the trace detail on a phone", async () => {
        const uiSession = await openAdminUi(`/traces?traceId=${LOG_TRACE_ID}`, 390);
        const { page } = uiSession;
        await page.getByRole("region", { name: "Logs of this trace" }).getByRole("heading", {
          name: "Logs (2)",
        }).waitFor();
        assertEquals(await measureHorizontalOverflow(page.locator("html")), 0);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });
    } finally {
      await browser?.close();
      await deployment.stop();
    }
  },
});

async function waitForRowCount(page: Page, expectedRowCount: number): Promise<void> {
  await waitForCondition(
    `${expectedRowCount} log rows show`,
    async () => await page.locator(".log-row").count() === expectedRowCount,
  );
}

async function readVisibleColumnHeadings(page: Page): Promise<string[]> {
  const visibleHeadings: string[] = [];
  for (const heading of await page.locator(".log-list-panel thead th").all()) {
    if (await heading.isVisible()) {
      visibleHeadings.push((await heading.innerText()).trim().toLowerCase());
    }
  }
  return visibleHeadings;
}

async function seedLogs(deployment: RunningDeployment): Promise<SeededLogs> {
  const uniquePart = crypto.randomUUID().replaceAll("-", "");
  const traceWord = `tracelog${uniquePart}`;
  const longBodyWord = `longbody${uniquePart}`;
  const pagedServiceName = `paged-service-${uniquePart}`;
  const rootSpanName = `handle-${uniquePart}`;
  const correlationId = `ui-log-${uniquePart}`;
  const nowNanoseconds = BigInt(Date.now()) * 1_000_000n;
  const authorizationHeaders = {
    authorization: `Bearer ${deployment.apiKey}`,
    "content-type": "application/json",
  };

  const sendOtlp = async (path: string, payload: unknown) => {
    const response = await fetch(`${deployment.otlpHttpUrl}${path}`, {
      method: "POST",
      headers: authorizationHeaders,
      body: JSON.stringify(payload),
    });
    assertEquals(response.status, 200, await response.clone().text());
    await response.body?.cancel();
  };

  await sendOtlp("/v1/traces", {
    resourceSpans: [{
      resource: { attributes: [stringAttribute("service.name", "ui-log-writer")] },
      scopeSpans: [{
        spans: [{
          traceId: LOG_TRACE_ID,
          spanId: LOG_SPAN_ID,
          name: rootSpanName,
          kind: 2,
          startTimeUnixNano: `${nowNanoseconds - 2_000_000_000n}`,
          endTimeUnixNano: `${nowNanoseconds}`,
          attributes: [stringAttribute("correlation.id", correlationId)],
        }],
      }],
    }],
  });

  const correlatedAttributes = [
    stringAttribute("correlation.id", correlationId),
    stringAttribute("gen_ai.request.model", "model-one"),
  ];
  await sendOtlp("/v1/logs", {
    resourceLogs: [{
      resource: { attributes: [stringAttribute("service.name", "ui-log-writer")] },
      scopeLogs: [{
        logRecords: [
          {
            timeUnixNano: `${nowNanoseconds - 1_500_000_000n}`,
            severityNumber: 9,
            severityText: "INFO",
            body: { stringValue: "Calling the model" },
            traceId: LOG_TRACE_ID,
            spanId: LOG_SPAN_ID,
            attributes: correlatedAttributes,
          },
          {
            timeUnixNano: `${nowNanoseconds - 1_000_000_000n}`,
            severityNumber: 17,
            severityText: "ERROR",
            body: { stringValue: `Payment failed ${traceWord}` },
            traceId: LOG_TRACE_ID,
            spanId: LOG_SPAN_ID,
            attributes: correlatedAttributes,
          },
          {
            timeUnixNano: `${nowNanoseconds - 500_000_000n}`,
            severityNumber: 13,
            body: {
              stringValue: `${longBodyWord} ${"x".repeat(6_000)} ${"long words ".repeat(400)}`,
            },
          },
          // No Correlation ID on a log of a trace: the rejected count has something to show.
          {
            timeUnixNano: `${nowNanoseconds}`,
            traceId: LOG_TRACE_ID,
            body: { stringValue: "refused" },
          },
        ],
      }],
    }],
  });

  await sendOtlp("/v1/logs", {
    resourceLogs: [{
      resource: { attributes: [stringAttribute("service.name", pagedServiceName)] },
      scopeLogs: [{
        logRecords: Array.from({ length: PAGED_RECORD_COUNT }, (_, recordIndex) => ({
          timeUnixNano: `${nowNanoseconds - BigInt(recordIndex) * 1_000_000n}`,
          severityNumber: 9,
          body: { stringValue: `paged record ${recordIndex}` },
        })),
      }],
    }],
  });

  await sendOtlp("/v1/traces", {
    resourceSpans: [{
      scopeSpans: [{
        spans: [{
          traceId: crypto.randomUUID().replaceAll("-", ""),
          spanId: "eee19b7ec3c1b175",
          name: "without-correlation",
          startTimeUnixNano: `${nowNanoseconds}`,
          endTimeUnixNano: `${nowNanoseconds}`,
        }],
      }],
    }],
  });

  return { traceWord, longBodyWord, pagedServiceName, rootSpanName };
}
