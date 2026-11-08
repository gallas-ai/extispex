/**
 * Browser tests of the web UI: the main flows, and the layout rules that keep the design intact,
 * such as which trace table columns show at which width and that nothing scrolls sideways.
 * They check rules rather than screenshots, so that they pass on every operating system's fonts.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Browser, Page } from "playwright-core";
import {
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  forgetExpectedRequestFailures,
  launchBrowser,
  measureHorizontalOverflow,
  openUi,
  readComputedStyle,
  readVisibleColumnHeadings,
  waitForCondition,
} from "./browser.ts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";

const ALL_COLUMNS = ["trace", "session", "correlation id", "spans", "duration", "started"];
/** The Correlation ID gives way first when the list alone is narrower than a laptop screen. */
const COLUMNS_ON_A_NARROW_LIST = ["trace", "session", "spans", "duration", "started"];
const COLUMNS_BESIDE_OPEN_TRACE = ["trace", "duration", "started"];
/** Every window width the layout must fit without scrolling sideways, phone to wide monitor. */
const SWEPT_WIDTHS = Array.from({ length: 42 }, (_, widthIndex) => 360 + widthIndex * 40);

/** The waterfall of the agent trace: span name and nesting level, in display order. */
const AGENT_TRACE_WATERFALL: [string, number][] = [
  ["POST /chat", 1],
  ["invoke_agent support-agent", 2],
  ["retrieve knowledge-base", 3],
  ["embeddings text-embedding-3-small", 4],
  ["chat claude-sonnet-5-5", 3],
  ["execute_tool find_order", 3],
  ["GET orders-api /orders/4512", 4],
  ["chat claude-sonnet-5-5", 3],
];

interface SeededTraces {
  /** Session with the eight-span agent trace and one older single-span trace. */
  agentSessionId: string;
  agentCorrelationId: string;
  /** Session with two single-span traces, reached by filtering from one of them. */
  otherSessionId: string;
  otherCorrelationId: string;
}

Deno.test({
  name: "web UI",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const seededTraces = await seedTraces(deployment);
      const openBrowser = browser;
      const agentSessionPath = `/?sessionId=${encodeURIComponent(seededTraces.agentSessionId)}`;

      await testContext.step(
        "signs in and shows the first Project with the user's Role",
        async () => {
          const uiSession = await openUi(openBrowser, deployment, { width: 1280, account: null });
          const { page } = uiSession;
          await page.getByRole("heading", { name: "Sign in to Extispex" }).waitFor();
          await page.getByLabel("Email").fill(deployment.admin.email);
          await page.getByLabel("Password", { exact: true }).fill(deployment.admin.password);
          await page.getByRole("button", { name: "Sign in" }).click();
          await page.getByRole("heading", { name: "Traces", level: 1 }).waitFor();
          assertEquals(
            (await page.locator(".project-switcher-trigger").innerText()).replace(/\s+/g, " ")
              .trim(),
            "Default admin",
          );
          // A reload keeps the browser signed in: the cookie gets a new access token.
          await page.reload();
          await page.getByRole("heading", { name: "Traces", level: 1 }).waitFor();
          assertNoPageErrors(uiSession);
          await uiSession.close();
        },
      );

      await testContext.step("explains a wrong password and signs out", async () => {
        const uiSession = await openUi(openBrowser, deployment, { width: 1280, account: null });
        const { page } = uiSession;
        await page.getByLabel("Email").fill(deployment.admin.email);
        await page.getByLabel("Password", { exact: true }).fill("not-the-password");
        await page.getByRole("button", { name: "Sign in" }).click();
        assertStringIncludes(
          await page.locator(".connect-form [role=alert]").innerText(),
          "email address or password is wrong",
        );
        await page.getByLabel("Password", { exact: true }).fill(deployment.admin.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("heading", { name: "Traces", level: 1 }).waitFor();
        await page.locator(".user-menu-trigger").click();
        await page.getByRole("button", { name: "Sign out" }).click();
        await page.getByRole("heading", { name: "Sign in to Extispex" }).waitFor();
        await page.reload();
        await page.getByRole("heading", { name: "Sign in to Extispex" }).waitFor();
        forgetExpectedRequestFailures(uiSession, [401]);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      for (
        const [width, expectedColumns] of [
          [1000, COLUMNS_ON_A_NARROW_LIST],
          [1280, ALL_COLUMNS],
          [2000, ALL_COLUMNS],
        ] as const
      ) {
        await testContext.step(
          `shows the list's columns without a trace open at ${width}px`,
          async () => {
            const uiSession = await openUi(openBrowser, deployment, {
              width,
              account: deployment.admin,
              path: agentSessionPath,
            });
            const { page } = uiSession;
            await waitForTraceRows(page, 2);
            assertEquals(await readVisibleColumnHeadings(page), [...expectedColumns]);
            await assertNoHorizontalOverflow(page, `with only the list at ${width}px`);
            if (width >= 2000) {
              for (const identifier of await page.locator(".trace-list-panel .identifier").all()) {
                assertEquals(
                  await measureHorizontalOverflow(identifier),
                  0,
                  `${await identifier.innerText()} is cut off although the list has room.`,
                );
              }
            }
            assertNoPageErrors(uiSession);
            await uiSession.close();
          },
        );
      }

      for (const width of [1100, 1440, 2000]) {
        await testContext.step(
          `gives an open trace most of the width at ${width}px`,
          async () => {
            const uiSession = await openUi(openBrowser, deployment, {
              width,
              account: deployment.admin,
              path: agentSessionPath,
            });
            const { page } = uiSession;
            await openTraceByRootSpanName(page, "POST /chat");
            assertEquals(await readVisibleColumnHeadings(page), COLUMNS_BESIDE_OPEN_TRACE);
            // The list keeps 28% of the width, at least 400px and at most 520px; the rest is the trace.
            const listWidth = await measureWidth(page, ".trace-list-panel");
            const detailWidth = await measureWidth(page, ".trace-detail-panel");
            assert(
              listWidth >= 399 && listWidth <= 521,
              `The list beside an open trace is ${listWidth}px wide.`,
            );
            assert(
              detailWidth > listWidth,
              `The detail is ${detailWidth}px wide and the list ${listWidth}px.`,
            );
            assertEquals(
              await readComputedStyle(page.locator(".trace-detail-panel"), "position"),
              "static",
              "The trace should open beside the list, not over it.",
            );
            await assertNoHorizontalOverflow(page, `with a trace open at ${width}px`);
            assertNoPageErrors(uiSession);
            await uiSession.close();
          },
        );
      }

      await testContext.step("never scrolls sideways at any window width", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: SWEPT_WIDTHS[0],
          account: deployment.admin,
          path: agentSessionPath,
        });
        const { page } = uiSession;
        await waitForTraceRows(page, 2);
        for (const traceState of ["list only", "trace open"]) {
          if (traceState === "trace open") await openTraceByRootSpanName(page, "POST /chat");
          for (const width of SWEPT_WIDTHS) {
            await page.setViewportSize({ width, height: 900 });
            await assertNoHorizontalOverflow(page, `with the ${traceState} at ${width}px`);
            if (traceState === "trace open") {
              assertEquals(
                await measureHorizontalOverflow(page.locator(".trace-detail-panel")),
                0,
                `The trace detail scrolls sideways at ${width}px.`,
              );
            }
          }
        }
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("shows the span tree with the root span selected", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1440,
          account: deployment.admin,
          path: agentSessionPath,
        });
        const { page } = uiSession;
        await openTraceByRootSpanName(page, "POST /chat");
        assertEquals(await readWaterfall(page), AGENT_TRACE_WATERFALL);
        assertEquals(await readSelectedSpanName(page), "POST /chat");
        assertEquals(await page.locator(".time-axis-tick").count(), 5);
        assertEquals(await readStat(page, "Spans"), "8");
        assertEquals(await readStat(page, "Errors"), "1");
        const errorRow = page.getByRole("treeitem").filter({ hasText: "GET orders-api" });
        assertEquals(await errorRow.locator(".span-badge-error").innerText(), "Error");
        const modelRow = page.getByRole("treeitem").filter({ hasText: "chat claude" }).first();
        assertEquals(
          (await modelRow.locator(".span-badge-model").innerText()).trim(),
          "claude-sonnet-5-5",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("shows a model span's tokens and its messages as JSON", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1440,
          account: deployment.admin,
          path: agentSessionPath,
        });
        const { page } = uiSession;
        await openTraceByRootSpanName(page, "POST /chat");
        await page.getByRole("treeitem").filter({ hasText: "chat claude" }).first().click();
        await page.waitForURL(/spanId=/);
        const spanDetails = page.locator(".span-details");
        assertEquals(await readProperty(page, "Model"), "claude-sonnet-5-5");
        assertEquals(await readProperty(page, "Input tokens"), "1,834");
        assertEquals(await readProperty(page, "Output tokens"), "96");
        assertStringIncludes(
          await spanDetails.locator("pre.attribute-json").innerText(),
          '"role": "system"',
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("shows a failed span's status message", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1440,
          account: deployment.admin,
          path: agentSessionPath,
        });
        const { page } = uiSession;
        await openTraceByRootSpanName(page, "POST /chat");
        await page.getByRole("treeitem").filter({ hasText: "GET orders-api" }).click();
        assertStringIncludes(
          await page.locator(".span-details .callout-danger").innerText(),
          "orders-api returned 503 Service Unavailable",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step(
        "moves through and folds the span tree with the keyboard",
        async () => {
          const uiSession = await openUi(openBrowser, deployment, {
            width: 1440,
            account: deployment.admin,
            path: agentSessionPath,
          });
          const { page } = uiSession;
          await openTraceByRootSpanName(page, "POST /chat");
          await page.getByRole("treeitem", { selected: true }).focus();
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("ArrowDown");
          assertEquals(await readSelectedSpanName(page), "retrieve knowledge-base");
          await page.keyboard.press("ArrowLeft");
          await waitForCondition(
            "the retrieval span folds",
            async () => (await page.getByRole("treeitem").count()) === 7,
          );
          assertEquals(
            await page.getByRole("treeitem", { selected: true }).getAttribute("aria-expanded"),
            "false",
          );
          await page.keyboard.press("ArrowRight");
          await waitForCondition(
            "the retrieval span unfolds",
            async () => (await page.getByRole("treeitem").count()) === 8,
          );
          assertNoPageErrors(uiSession);
          await uiSession.close();
        },
      );

      await testContext.step("keeps the open trace in the URL and closes it", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1440,
          account: deployment.admin,
          path: agentSessionPath,
        });
        const { page } = uiSession;
        await openTraceByRootSpanName(page, "POST /chat");
        const traceUrl = page.url();
        assertStringIncludes(traceUrl, "traceId=");

        await page.keyboard.press("Escape");
        await page.locator(".trace-detail-panel").waitFor({ state: "detached" });
        assert(!page.url().includes("traceId="), "Escape should remove the trace from the URL.");

        await page.goBack();
        await page.locator(".trace-detail-panel [role=tree]").waitFor();
        assertEquals(page.url(), traceUrl);

        await page.reload();
        await page.locator(".trace-detail-panel [role=tree]").waitFor();
        assertEquals(await readSelectedSpanName(page), "POST /chat");

        await page.keyboard.press("Escape");
        await page.locator(".trace-detail-panel").waitFor({ state: "detached" });
        // The list loads apart from the open trace, and `j` moves through the list.
        await page.locator(".trace-row").first().waitFor();
        await page.keyboard.press("j");
        await page.locator(".trace-detail-panel [role=tree]").waitFor();
        assertEquals(
          await page.locator(".trace-row-selected .trace-cell-name").innerText(),
          "POST /chat",
          "j should open the newest trace.",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("filters the list by a trace's Session", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1440,
          account: deployment.admin,
          path: `/?correlationId=${encodeURIComponent(seededTraces.otherCorrelationId)}`,
        });
        const { page } = uiSession;
        await waitForTraceRows(page, 1);
        await page.locator(".trace-row .trace-cell-name").first().click();
        await page.locator(".trace-detail-panel [role=tree]").waitFor();
        await page.locator(".identifier-card")
          .filter({ hasText: "Session" })
          .getByRole("button", { name: "Show this Session's traces" })
          .click();
        await waitForTraceRows(page, 2);
        const currentUrl = new URL(page.url());
        assertEquals(currentUrl.searchParams.get("sessionId"), seededTraces.otherSessionId);
        assertEquals(currentUrl.searchParams.get("correlationId"), null);
        assertEquals(
          await page.locator("#session-id-filter").inputValue(),
          seededTraces.otherSessionId,
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("opens a trace as a drawer over the list below 1100px", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1000,
          height: 800,
          account: deployment.admin,
          path: agentSessionPath,
        });
        const { page } = uiSession;
        await waitForTraceRows(page, 2);
        await openTraceByRootSpanName(page, "POST /chat");
        assertEquals(
          await readComputedStyle(page.locator(".trace-detail-panel"), "position"),
          "fixed",
        );
        await assertNoHorizontalOverflow(page, "with the drawer open at 1000px");
        // The backdrop is the part of the window to the left of the drawer.
        await page.mouse.click(40, 400);
        await page.locator(".trace-detail-panel").waitFor({ state: "detached" });
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("fits a phone screen without scrolling sideways", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 390,
          height: 844,
          account: deployment.admin,
          path: agentSessionPath,
        });
        const { page } = uiSession;
        await waitForTraceRows(page, 2);
        const visibleColumns = await readVisibleColumnHeadings(page);
        assertEquals(visibleColumns.slice(0, 2), ["trace", "duration"]);
        assert(!visibleColumns.includes("session"), "The Session column should give way.");
        await assertNoHorizontalOverflow(page, "with the list on a phone");
        await openTraceByRootSpanName(page, "POST /chat");
        await assertNoHorizontalOverflow(page, "with a trace open on a phone");
        assertEquals(
          await measureHorizontalOverflow(page.locator(".trace-detail-panel")),
          0,
          "The trace drawer scrolls sideways on a phone.",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("switches between light and dark and remembers it", async () => {
        const uiSession = await openUi(openBrowser, deployment, {
          width: 1280,
          account: deployment.admin,
          colorScheme: "light",
          path: agentSessionPath,
        });
        const { page } = uiSession;
        await waitForTraceRows(page, 2);
        const lightBackground = await readBodyBackground(page);
        await page.getByRole("radio", { name: "Dark theme" }).click();
        assertEquals(await page.locator("html").getAttribute("data-theme"), "dark");
        await waitForCondition(
          "the dark theme changes the page background",
          async () => (await readBodyBackground(page)) !== lightBackground,
        );
        const darkBackground = await readBodyBackground(page);
        await page.reload();
        await waitForTraceRows(page, 2);
        assertEquals(await readBodyBackground(page), darkBackground);
        assertEquals(
          await page.getByRole("radio", { name: "Dark theme" }).getAttribute("aria-checked"),
          "true",
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

async function waitForTraceRows(page: Page, expectedRowCount: number): Promise<void> {
  await waitForCondition(
    `the list shows ${expectedRowCount} traces`,
    async () => (await page.locator(".trace-row").count()) === expectedRowCount,
  );
}

async function openTraceByRootSpanName(page: Page, rootSpanName: string): Promise<void> {
  // The name, not the row's centre, which can hold a cell's own button such as the Session filter.
  await page.locator(".trace-row .trace-cell-name", { hasText: rootSpanName }).first().click();
  await page.locator(".trace-detail-panel [role=tree]").waitFor();
}

async function readWaterfall(page: Page): Promise<[string, number][]> {
  const waterfallRows: [string, number][] = [];
  for (const treeItem of await page.getByRole("treeitem").all()) {
    waterfallRows.push([
      await treeItem.locator(".waterfall-span-name").innerText(),
      Number(await treeItem.getAttribute("aria-level")),
    ]);
  }
  return waterfallRows;
}

async function readSelectedSpanName(page: Page): Promise<string> {
  return await page.getByRole("treeitem", { selected: true }).locator(".waterfall-span-name")
    .innerText();
}

async function readStat(page: Page, label: string): Promise<string> {
  return (await page.locator(".stat").filter({ hasText: label }).locator("dd").innerText()).trim();
}

async function readProperty(page: Page, label: string): Promise<string> {
  const property = page.locator(".property").filter({
    has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }),
  });
  return (await property.locator("dd").innerText()).trim();
}

async function measureWidth(page: Page, selector: string): Promise<number> {
  return await page.locator(selector).evaluate((element) => element.getBoundingClientRect().width);
}

async function readBodyBackground(page: Page): Promise<string> {
  return await readComputedStyle(page.locator("body"), "backgroundColor");
}

/**
 * Sends the traces the steps look at over OTLP/HTTP JSON. Fresh IDs keep them apart from
 * traces that other tests leave in a shared database.
 */
async function seedTraces(deployment: RunningDeployment): Promise<SeededTraces> {
  // Session IDs as long as real applications make them, so that truncation is exercised.
  const runId = crypto.randomUUID();
  const seededTraces: SeededTraces = {
    agentSessionId: `ui-agent-session-${runId}`,
    agentCorrelationId: crypto.randomUUID(),
    otherSessionId: `ui-other-session-${runId}`,
    otherCorrelationId: crypto.randomUUID(),
  };
  const nowMilliseconds = Date.now();
  const resourceSpans = [
    buildTrace({
      correlationId: crypto.randomUUID(),
      sessionId: seededTraces.agentSessionId,
      startMilliseconds: nowMilliseconds - 60_000,
      spans: [{ key: "root", parentKey: null, name: "handle-message", kind: 1, from: 0, to: 40 }],
    }),
    buildTrace({
      correlationId: seededTraces.agentCorrelationId,
      sessionId: seededTraces.agentSessionId,
      startMilliseconds: nowMilliseconds - 5_000,
      spans: [
        { key: "root", parentKey: null, name: "POST /chat", kind: 2, from: 0, to: 2840 },
        {
          key: "agent",
          parentKey: "root",
          name: "invoke_agent support-agent",
          kind: 1,
          from: 12,
          to: 2810,
        },
        {
          key: "retrieve",
          parentKey: "agent",
          name: "retrieve knowledge-base",
          kind: 3,
          from: 20,
          to: 310,
        },
        {
          key: "embed",
          parentKey: "retrieve",
          name: "embeddings text-embedding-3-small",
          kind: 3,
          from: 25,
          to: 140,
          attributes: { "gen_ai.request.model": "text-embedding-3-small" },
        },
        {
          key: "firstChat",
          parentKey: "agent",
          name: "chat claude-sonnet-5-5",
          kind: 3,
          from: 320,
          to: 1490,
          attributes: {
            "gen_ai.request.model": "claude-sonnet-5-5",
            "gen_ai.usage.input_tokens": 1834,
            "gen_ai.usage.output_tokens": 96,
            "gen_ai.input.messages": JSON.stringify([
              { role: "system", content: "You are a support agent." },
              { role: "user", content: "Where is my order #4512?" },
            ]),
          },
        },
        {
          key: "tool",
          parentKey: "agent",
          name: "execute_tool find_order",
          kind: 1,
          from: 1500,
          to: 1720,
          attributes: { "gen_ai.tool.name": "find_order" },
        },
        {
          key: "ordersApi",
          parentKey: "tool",
          name: "GET orders-api /orders/4512",
          kind: 3,
          from: 1510,
          to: 1700,
          errorMessage: "orders-api returned 503 Service Unavailable",
        },
        {
          key: "secondChat",
          parentKey: "agent",
          name: "chat claude-sonnet-5-5",
          kind: 3,
          from: 1730,
          to: 2790,
          attributes: { "gen_ai.request.model": "claude-sonnet-5-5" },
        },
      ],
    }),
    buildTrace({
      correlationId: seededTraces.otherCorrelationId,
      sessionId: seededTraces.otherSessionId,
      startMilliseconds: nowMilliseconds - 30_000,
      spans: [{ key: "root", parentKey: null, name: "handle-message", kind: 1, from: 0, to: 25 }],
    }),
    buildTrace({
      correlationId: crypto.randomUUID(),
      sessionId: seededTraces.otherSessionId,
      startMilliseconds: nowMilliseconds - 20_000,
      spans: [{ key: "root", parentKey: null, name: "handle-message", kind: 1, from: 0, to: 30 }],
    }),
  ];
  const response = await fetch(`${deployment.otlpHttpUrl}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deployment.apiKey}`,
    },
    body: JSON.stringify({ resourceSpans }),
  });
  assertEquals(response.status, 200, `Seeding traces failed: ${await response.text()}`);
  await waitForCondition("the seeded traces are stored", async () => {
    const listResponse = await fetch(
      `${deployment.gatewayUrl}/v1/traces?sessionId=${seededTraces.otherSessionId}`,
      { headers: { authorization: `Bearer ${deployment.apiKey}` } },
    );
    const { traces } = await listResponse.json() as { traces: unknown[] };
    return traces.length === 2;
  });
  return seededTraces;
}

interface SpanDefinition {
  key: string;
  parentKey: string | null;
  name: string;
  /** OTLP span kind: 1 internal, 2 server, 3 client. */
  kind: number;
  /** Milliseconds after the trace start. */
  from: number;
  to: number;
  attributes?: Record<string, string | number>;
  errorMessage?: string;
}

function buildTrace(
  { correlationId, sessionId, startMilliseconds, spans }: {
    correlationId: string;
    sessionId: string;
    startMilliseconds: number;
    spans: SpanDefinition[];
  },
) {
  const traceId = randomHex(16);
  const spanIdByKey = new Map(spans.map((span) => [span.key, randomHex(8)]));
  const toUnixNanoseconds = (offsetMilliseconds: number) =>
    String(BigInt(Math.round((startMilliseconds + offsetMilliseconds) * 1000)) * 1000n);
  return {
    resource: { attributes: toOtlpAttributes({ "service.name": "support-agent" }) },
    scopeSpans: [{
      scope: { name: "web-ui-e2e" },
      spans: spans.map((span) => ({
        traceId,
        spanId: spanIdByKey.get(span.key),
        parentSpanId: span.parentKey === null ? undefined : spanIdByKey.get(span.parentKey),
        name: span.name,
        kind: span.kind,
        startTimeUnixNano: toUnixNanoseconds(span.from),
        endTimeUnixNano: toUnixNanoseconds(span.to),
        attributes: toOtlpAttributes({
          "correlation.id": correlationId,
          "session.id": sessionId,
          ...span.attributes,
        }),
        status: span.errorMessage === undefined
          ? { code: 0 }
          : { code: 2, message: span.errorMessage },
      })),
    }],
  };
}

function toOtlpAttributes(attributes: Record<string, string | number>) {
  return Object.entries(attributes).map(([key, attributeValue]) => ({
    key,
    value: typeof attributeValue === "number"
      ? { intValue: attributeValue }
      : { stringValue: attributeValue },
  }));
}

function randomHex(byteCount: number): string {
  return [...crypto.getRandomValues(new Uint8Array(byteCount))]
    .map((byteValue) => byteValue.toString(16).padStart(2, "0"))
    .join("");
}
