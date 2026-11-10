/**
 * Browser tests of the Metrics page: choosing a metric, an aggregation and a grouping, the chart
 * and its table, the limit of eight lines, and the layout rules that keep the page from scrolling
 * sideways.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Browser, Page } from "playwright-core";
import {
  assertNoPageErrors,
  launchBrowser,
  measureHorizontalOverflow,
  openUi,
  readComputedStyle,
  waitForCondition,
} from "./browser.ts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";

/** Every window width the layout must fit without scrolling sideways, phone to wide monitor. */
const SWEPT_WIDTHS = Array.from({ length: 22 }, (_, widthIndex) => 360 + widthIndex * 80);
const MODELS = ["model-a", "model-b", "model-c"];
const REGIONS = Array.from({ length: 10 }, (_, regionIndex) => `region-${regionIndex}`);

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

Deno.test({
  name: "metrics web UI",
  // Chromium runs in a child process whose pipes outlive individual steps.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const openBrowser = browser;
      await seedMetrics(deployment);
      const openAdminUi = (path: string, width = 1280) =>
        openUi(openBrowser, deployment, { width, account: deployment.admin, path });

      await testContext.step("opens from the navigation with a chart", async () => {
        const uiSession = await openAdminUi("/traces");
        const { page } = uiSession;
        await page.getByRole("link", { name: "Metrics" }).click();
        await page.getByRole("heading", { name: "Metrics", level: 1 }).waitFor();
        // Other tests may have sent metrics to the same Project, so the first one is not known.
        await page.locator(".metric-chart").waitFor();
        // A histogram opens with its 95th percentile.
        await page.getByLabel("Metric", { exact: true }).selectOption("ui.latency");
        await page.getByRole("heading", { name: "95th percentile of ui.latency" }).waitFor();
        await waitForSeriesCount(page, 1);
        assertEquals(await page.locator(".metric-series-table tbody tr").count(), 1);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("groups a metric and keeps the chart in the link", async () => {
        const uiSession = await openAdminUi("/metrics?metric=ui.latency");
        const { page } = uiSession;
        await waitForSeriesCount(page, 1);
        await page.getByLabel("Metric", { exact: true }).selectOption("ui.tokens");
        await page.getByRole("heading", { name: "Rate per second of ui.tokens" }).waitFor();
        await page.getByLabel("Aggregation").selectOption("sum");
        await page.getByLabel("Group by").selectOption("gen_ai.request.model");
        await page.getByRole("heading", { name: "Sum of ui.tokens" }).waitFor();
        await waitForSeriesCount(page, MODELS.length);
        assertStringIncludes(page.url(), "groupBy=gen_ai.request.model");
        await page.reload();
        await waitForSeriesCount(page, MODELS.length);
        const labels = await page.locator(".metric-series-name").allInnerTexts();
        assertEquals(labels, MODELS);
        assertEquals(
          await page.locator(".metric-series-table thead th").first().textContent(),
          "gen_ai.request.model",
        );
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("filters by an attribute", async () => {
        const uiSession = await openAdminUi(
          "/metrics?metric=ui.tokens&aggregation=sum&groupBy=gen_ai.request.model",
        );
        const { page } = uiSession;
        await waitForSeriesCount(page, MODELS.length);
        await page.getByPlaceholder("Attribute: key=value").fill("gen_ai.request.model=model-b");
        await page.getByRole("button", { name: "Apply filter" }).click();
        await waitForSeriesCount(page, 1);
        assertStringIncludes(page.url(), "attribute=");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("draws at most eight lines and lists every group", async () => {
        const uiSession = await openAdminUi("/metrics?metric=ui.queue_size&groupBy=region");
        const { page } = uiSession;
        await waitForSeriesCount(page, 8);
        assertEquals(await page.locator(".metric-series-table tbody tr").count(), REGIONS.length);
        assertStringIncludes(
          await page.locator(".metric-chart-note").innerText(),
          `8 largest of ${REGIONS.length} groups`,
        );
        // The chart's lines keep their colors when a filter leaves fewer of them.
        const swatchColor = (region: string) =>
          readComputedStyle(
            page.locator(".metric-series-table tbody tr", { hasText: region })
              .locator(".metric-series-swatch"),
            "background-color",
          );
        const colorBefore = await swatchColor("region-9");
        await page.getByPlaceholder("Attribute: key=value").fill("region=region-9");
        await page.getByRole("button", { name: "Apply filter" }).click();
        await waitForSeriesCount(page, 1);
        assertEquals(await swatchColor("region-9"), colorBefore);
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("says when a linked metric does not exist", async () => {
        const uiSession = await openAdminUi("/metrics?metric=ui.missing");
        const { page } = uiSession;
        await page.getByRole("heading", { name: "The metric ui.missing does not exist" }).waitFor();
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("tells how many metric data points were rejected", async () => {
        const uiSession = await openAdminUi("/metrics");
        const { page } = uiSession;
        const notice = page.locator(".rejected-telemetry-notice");
        await notice.waitFor();
        assertStringIncludes(await notice.innerText(), "metric data point");
        assertStringIncludes(await notice.innerText(), "rejected in the last 24 hours");
        assertStringIncludes(await notice.innerText(), "summaries are not supported");
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("never scrolls sideways, with a chart and long labels", async () => {
        const uiSession = await openAdminUi("/metrics?metric=ui.queue_size&groupBy=region");
        const { page } = uiSession;
        await waitForSeriesCount(page, 8);
        for (const width of SWEPT_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          assertEquals(
            await measureHorizontalOverflow(page.locator("html")),
            0,
            `The page scrolls sideways at ${width}px.`,
          );
          const chartWidth = await page.locator(".metric-chart").evaluate((element) =>
            element.getBoundingClientRect().width
          );
          assert(chartWidth > 200, `The chart is ${chartWidth}px wide at ${width}px.`);
        }
        assertNoPageErrors(uiSession);
        await uiSession.close();
      });

      await testContext.step("draws the chart in the dark theme's colors", async () => {
        const uiSession = await openAdminUi(
          "/metrics?metric=ui.tokens&groupBy=gen_ai.request.model",
        );
        const { page } = uiSession;
        await waitForSeriesCount(page, MODELS.length);
        const readFirstLineColor = () =>
          page.locator(".metric-chart svg path[fill='none']").first().getAttribute("stroke");
        const lightColor = await readFirstLineColor();
        await page.getByRole("radio", { name: "Dark theme" }).click();
        await waitForCondition(
          "the chart's lines change color",
          async () => await readFirstLineColor() !== lightColor,
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

async function waitForSeriesCount(page: Page, expectedCount: number): Promise<void> {
  await waitForCondition(
    `the chart draws ${expectedCount} lines`,
    async () =>
      await page.locator(`.metric-chart[data-series-count="${expectedCount}"]`).count() === 1,
  );
}

async function seedMetrics(deployment: RunningDeployment): Promise<void> {
  const nowNanoseconds = BigInt(Date.now()) * 1_000_000n;
  const minutesAgo = (minutes: number) => `${nowNanoseconds - BigInt(minutes) * 60_000_000_000n}`;
  const sendOtlp = async (payload: unknown) => {
    const response = await fetch(`${deployment.otlpHttpUrl}/v1/metrics`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deployment.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assertEquals(response.status, 200, await response.clone().text());
    await response.body?.cancel();
  };
  await sendOtlp({
    resourceMetrics: [{
      resource: { attributes: [stringAttribute("service.name", "ui-metric-writer")] },
      scopeMetrics: [{
        metrics: [
          {
            name: "ui.tokens",
            unit: "{token}",
            sum: {
              aggregationTemporality: 1,
              isMonotonic: true,
              dataPoints: MODELS.flatMap((model, modelIndex) =>
                [20, 10, 5].map((minutes) => ({
                  timeUnixNano: minutesAgo(minutes),
                  asInt: `${(modelIndex + 1) * 100}`,
                  attributes: [stringAttribute("gen_ai.request.model", model)],
                }))
              ),
            },
          },
          {
            name: "ui.queue_size",
            gauge: {
              dataPoints: REGIONS.flatMap((region, regionIndex) =>
                [15, 5].map((minutes) => ({
                  timeUnixNano: minutesAgo(minutes),
                  asDouble: regionIndex + 1,
                  attributes: [
                    stringAttribute("region", region),
                    stringAttribute("detail", "a long attribute value ".repeat(8)),
                  ],
                }))
              ),
            },
          },
          {
            name: "ui.latency",
            unit: "ms",
            histogram: {
              aggregationTemporality: 1,
              dataPoints: [10, 3].map((minutes) => ({
                timeUnixNano: minutesAgo(minutes),
                count: "100",
                sum: 5_000,
                bucketCounts: ["50", "40", "10", "0"],
                explicitBounds: [10, 100, 1000],
              })),
            },
          },
          { name: "ui.summary", summary: { dataPoints: [{ timeUnixNano: minutesAgo(1) }] } },
        ],
      }],
    }],
  });
}
