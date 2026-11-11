import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createMetricQueries, MetricQueryError } from "../src/metrics/metric-query.ts";
import type {
  MetricRepository,
  MetricStepTotals,
  StoredMetricSeries,
} from "../src/storage/metric-repository.ts";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const MAXIMUM_ROWS_READ = 100_000;

function createSeries(seriesId: string): StoredMetricSeries {
  return {
    seriesId,
    metricName: "requests",
    metricType: "sum",
    unit: "1",
    temporality: "delta",
    isMonotonic: true,
    explicitBounds: null,
    serviceName: "api",
    attributes: {},
    resourceAttributes: {},
  };
}

function createRepository(
  series: StoredMetricSeries[],
  stepTotals: MetricStepTotals[],
): MetricRepository {
  return {
    insertMetricPoints: () => Promise.resolve(),
    listMetricDefinitions: () => Promise.resolve([]),
    listSeries: () => Promise.resolve(series),
    readStepTotals: () => Promise.resolve(stepTotals),
    readCumulativeStepTotals: () => Promise.resolve([]),
    readHistogramPoints: () => Promise.resolve([]),
  };
}

const QUERY = { metric: "requests", aggregation: "sum" } as const;

Deno.test("asks to narrow a query that reads too many points", async () => {
  const stepTotals = Array.from({ length: MAXIMUM_ROWS_READ + 1 }, (_row, stepIndex) => ({
    seriesId: "one",
    stepIndex,
    valueTotal: 1,
    pointCount: 1,
  }));
  const queries = createMetricQueries(
    createRepository([createSeries("one")], stepTotals),
    () => NOW,
  );
  const error = await assertRejects(
    () => queries.queryMetric("project", QUERY),
    MetricQueryError,
  );
  assertEquals(error.errorCode, "too_many_points");
  assertStringIncludes(error.message, "Narrow the time range");
});

Deno.test("asks to narrow a query that matches too many Time Series", async () => {
  const series = Array.from({ length: 2_001 }, (_series, index) => createSeries(`series-${index}`));
  const queries = createMetricQueries(createRepository(series, []), () => NOW);
  const error = await assertRejects(
    () => queries.queryMetric("project", QUERY),
    MetricQueryError,
  );
  assertEquals(error.errorCode, "too_many_series");
  assertStringIncludes(error.message, "Narrow it");
});

Deno.test("refuses a metric with more Time Series than can be filtered", async () => {
  const series = Array.from(
    { length: 20_001 },
    (_series, index) => createSeries(`series-${index}`),
  );
  const queries = createMetricQueries(createRepository(series, []), () => NOW);
  const error = await assertRejects(
    () => queries.queryMetric("project", QUERY),
    MetricQueryError,
  );
  assertEquals(error.errorCode, "too_many_series");
});
