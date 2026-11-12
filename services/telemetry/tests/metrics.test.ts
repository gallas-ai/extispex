import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createRequestAuthenticator,
  createStructuredLogger,
  type ProjectResolver,
} from "@extispex/service-runtime";
import {
  createTestAccessTokens,
  createTestProjectLifecycle,
} from "@extispex/service-runtime/testing";
import { listTestDatabases } from "@extispex/service-storage/testing";
import type {
  ListMetricAttributesResponse,
  ListMetricsResponse,
  QueryMetricResponse,
  RejectedTelemetry,
} from "@extispex/contracts";
import protobuf from "protobufjs";
import {
  createTelemetryService,
  openTelemetryDatabase,
  type TelemetryDatabase,
  type TelemetryService,
} from "../src/create-service.ts";
import otlpDescriptor from "../src/ingestion/generated/otlp-descriptor.json" with { type: "json" };

const API_KEY = "test-api-key";
const OTHER_PROJECT_API_KEY = "other-project-api-key";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const NOW_NANOSECONDS = BigInt(NOW.getTime()) * 1_000_000n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const NANOSECONDS_PER_DAY = 86_400_000_000_000n;
const CUMULATIVE = 2;
const DELTA = 1;
const STEP_SECONDS = 300;
/** Two five-minute steps: 11:50 to 11:55 and 11:55 to 12:00. */
const TWO_STEPS = `from=2026-11-09T11:50:00Z&to=2026-11-09T12:00:00Z&stepSeconds=${STEP_SECONDS}`;

const testProjectResolver: ProjectResolver = {
  resolveProjectId: (apiKey) =>
    Promise.resolve(
      ({ [API_KEY]: "project-one", [OTHER_PROJECT_API_KEY]: "project-two" })[apiKey] ?? null,
    ),
};
const testAccessTokens = await createTestAccessTokens();
const testRequestAuthenticator = createRequestAuthenticator({
  projectResolver: testProjectResolver,
  accessTokenVerifier: testAccessTokens.accessTokenVerifier,
});

function createService(database: TelemetryDatabase) {
  return createTelemetryService({
    database,
    requestAuthenticator: testRequestAuthenticator,
    projectLifecycle: createTestProjectLifecycle(),
    logger: createStructuredLogger("telemetry-test"),
    readCurrentTime: () => NOW,
  });
}

async function clearMetrics(database: TelemetryDatabase): Promise<void> {
  const entityManager = database.orm.em.fork();
  await entityManager.execute("delete from metric_points");
  await entityManager.execute("delete from metric_series");
  await entityManager.execute("delete from rejection_counts");
}

type MetricTestBody = (service: TelemetryService, database: TelemetryDatabase) => Promise<void>;

function defineMetricTest(testName: string, testBody: MetricTestBody): void {
  for (const testDatabase of listTestDatabases("telemetry")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openTelemetryDatabase(testDatabase.url);
      try {
        await clearMetrics(database);
        await testBody(createService(database), database);
      } finally {
        await database.close();
      }
    });
  }
}

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/** A time given as minutes and seconds past 11:00 on the test's day. */
function atTime(minutesPastEleven: number, seconds = 0): string {
  const secondsBeforeNow = BigInt((60 - minutesPastEleven) * 60 - seconds);
  return (NOW_NANOSECONDS - secondsBeforeNow * NANOSECONDS_PER_SECOND).toString();
}

function numberPoint(
  timeUnixNano: string,
  asDouble: number,
  extraFields: Record<string, unknown> = {},
) {
  return { timeUnixNano, asDouble, ...extraFields };
}

function createRequest(metrics: unknown[], serviceName = "support-bot") {
  return {
    resourceMetrics: [{
      resource: { attributes: [stringAttribute("service.name", serviceName)] },
      scopeMetrics: [{ scope: { name: "test-meter" }, metrics }],
    }],
  };
}

function createSum(
  name: string,
  dataPoints: unknown[],
  temporality = CUMULATIVE,
  isMonotonic = true,
) {
  return {
    name,
    unit: "1",
    sum: { dataPoints, aggregationTemporality: temporality, isMonotonic },
  };
}

function createGauge(name: string, dataPoints: unknown[]) {
  return { name, unit: "1", gauge: { dataPoints } };
}

function createHistogram(name: string, dataPoints: unknown[], temporality = DELTA) {
  return { name, unit: "ms", histogram: { dataPoints, aggregationTemporality: temporality } };
}

function sendRequest(
  service: TelemetryService,
  path: string,
  init: RequestInit & { apiKey?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${init.apiKey ?? API_KEY}`);
  return service.handleRequest(new Request(`http://telemetry.test${path}`, { ...init, headers }));
}

function postJsonMetrics(service: TelemetryService, payload: unknown, apiKey?: string) {
  return sendRequest(service, "/v1/metrics", {
    method: "POST",
    apiKey,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function postAccepted(service: TelemetryService, metrics: unknown[], serviceName?: string) {
  const response = await postJsonMetrics(service, createRequest(metrics, serviceName));
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(await response.json(), {});
}

async function queryMetric(
  service: TelemetryService,
  query: string,
  apiKey?: string,
): Promise<QueryMetricResponse> {
  const response = await sendRequest(service, `/v1/metrics/query?${query}`, { apiKey });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as QueryMetricResponse;
}

async function readValues(service: TelemetryService, query: string) {
  const { series } = await queryMetric(service, query);
  assertEquals(series.length, 1, `expected one series for ${query}`);
  return series[0].values;
}

defineMetricTest("turns a cumulative counter into increases, across a reset", async (service) => {
  await postAccepted(service, [createSum("requests", [
    numberPoint(atTime(51), 10, { startTimeUnixNano: atTime(49, 30) }),
    numberPoint(atTime(54), 25, { startTimeUnixNano: atTime(49, 30) }),
    numberPoint(atTime(56), 40, { startTimeUnixNano: atTime(49, 30) }),
    // A restarted process counts from a new start time.
    numberPoint(atTime(58), 5, { startTimeUnixNano: atTime(57) }),
  ])]);
  assertEquals(await readValues(service, `metric=requests&aggregation=sum&${TWO_STEPS}`), [25, 20]);
  assertEquals(
    await readValues(service, `metric=requests&aggregation=avg&${TWO_STEPS}`),
    [12.5, 10],
  );
  const rates = await readValues(service, `metric=requests&aggregation=rate&${TWO_STEPS}`);
  assertAlmostEquals(rates[0]!, 25 / STEP_SECONDS);
  assertAlmostEquals(rates[1]!, 20 / STEP_SECONDS);
});

defineMetricTest("detects a reset by a falling value without a start time", async (service) => {
  await postAccepted(service, [createSum("requests", [
    numberPoint(atTime(48), 100),
    numberPoint(atTime(52), 130),
    numberPoint(atTime(56), 4),
  ])]);
  assertEquals(await readValues(service, `metric=requests&aggregation=sum&${TWO_STEPS}`), [30, 4]);
});

defineMetricTest("uses the point before the time range but no older ones", async (service) => {
  const longAgo = atTime(0);
  await postAccepted(service, [
    createSum("in-lookback", [
      numberPoint(atTime(46), 100, { startTimeUnixNano: longAgo }),
      numberPoint(atTime(52), 130, { startTimeUnixNano: longAgo }),
    ]),
    // Ten minutes before the first step is the lookback's limit, and 11:30 is further away.
    createSum("beyond-lookback", [
      numberPoint(atTime(30), 100, { startTimeUnixNano: longAgo }),
      numberPoint(atTime(52), 130, { startTimeUnixNano: longAgo }),
    ]),
  ]);
  assertEquals(
    await readValues(service, `metric=in-lookback&aggregation=sum&${TWO_STEPS}`),
    [30, null],
  );
  assertEquals(
    await readValues(service, `metric=beyond-lookback&aggregation=sum&${TWO_STEPS}`),
    [null, null],
  );
});

defineMetricTest("adds delta sums as they are", async (service) => {
  await postAccepted(service, [createSum("sent", [
    numberPoint(atTime(51), 3),
    numberPoint(atTime(54), 4),
    numberPoint(atTime(56), 5),
  ], DELTA)]);
  assertEquals(await readValues(service, `metric=sent&aggregation=sum&${TWO_STEPS}`), [7, 5]);
  assertEquals(await readValues(service, `metric=sent&aggregation=avg&${TWO_STEPS}`), [3.5, 5]);
});

defineMetricTest("reads a gauge and an up-down counter as levels", async (service) => {
  const inRegion = (region: string) => ({ attributes: [stringAttribute("region", region)] });
  await postAccepted(service, [
    createGauge("queue-size", [
      numberPoint(atTime(51), 10, inRegion("eu")),
      numberPoint(atTime(53), 20, inRegion("eu")),
      numberPoint(atTime(52), 40, inRegion("us")),
    ]),
    createSum(
      "connections",
      [numberPoint(atTime(51), 7), numberPoint(atTime(53), 9)],
      CUMULATIVE,
      false,
    ),
  ]);
  // One level per Time Series: 15 in eu and 40 in us.
  assertEquals(await readValues(service, `metric=queue-size&aggregation=sum&${TWO_STEPS}`), [
    55,
    null,
  ]);
  const averages = await readValues(service, `metric=queue-size&aggregation=avg&${TWO_STEPS}`);
  assertAlmostEquals(averages[0]!, 70 / 3);
  assertEquals(await readValues(service, `metric=connections&aggregation=sum&${TWO_STEPS}`), [
    8,
    null,
  ]);
});

const BOUNDS = [10, 100, 1000];

function histogramPoint(
  timeUnixNano: string,
  bucketCounts: number[],
  sum: number | undefined,
  extraFields: Record<string, unknown> = {},
) {
  return {
    timeUnixNano,
    count: bucketCounts.reduce((total, bucketCount) => total + bucketCount, 0),
    sum,
    bucketCounts,
    explicitBounds: BOUNDS,
    ...extraFields,
  };
}

defineMetricTest("computes p95, sum, avg and rate from delta histograms", async (service) => {
  await postAccepted(service, [createHistogram("latency", [
    histogramPoint(atTime(51), [50, 40, 10, 0], 4_000),
    histogramPoint(atTime(56), [10, 0, 0, 0], 50),
  ])]);
  const p95 = await readValues(service, `metric=latency&aggregation=p95&${TWO_STEPS}`);
  assertAlmostEquals(p95[0]!, 550);
  assertAlmostEquals(p95[1]!, 9.5);
  assertEquals(await readValues(service, `metric=latency&aggregation=sum&${TWO_STEPS}`), [
    4_000,
    50,
  ]);
  assertEquals(await readValues(service, `metric=latency&aggregation=avg&${TWO_STEPS}`), [40, 5]);
  const rates = await readValues(service, `metric=latency&aggregation=rate&${TWO_STEPS}`);
  assertAlmostEquals(rates[0]!, 100 / STEP_SECONDS);
});

defineMetricTest("turns cumulative histograms into increases", async (service) => {
  const start = { startTimeUnixNano: atTime(50, 30) };
  await postAccepted(service, [createHistogram("latency", [
    histogramPoint(atTime(51), [10, 10, 0, 0], 200, start),
    histogramPoint(atTime(56), [60, 50, 10, 0], 4_200, start),
    // A restart: the counts begin again.
    histogramPoint(atTime(58), [1, 0, 0, 0], 5, { startTimeUnixNano: atTime(57) }),
  ], CUMULATIVE)]);
  const p95 = await readValues(service, `metric=latency&aggregation=p95&${TWO_STEPS}`);
  assertAlmostEquals(p95[0]!, 91);
  // The increase of 50, 40 and 10 observations, and one more after the restart: 51, 40, 10.
  assertAlmostEquals(p95[1]!, 545.5);
  assertEquals(
    await readValues(service, `metric=latency&aggregation=sum&${TWO_STEPS}`),
    [200, 4_005],
  );
});

defineMetricTest("adds histograms of several Time Series before the quantile", async (service) => {
  const inRegion = (region: string) => ({ attributes: [stringAttribute("region", region)] });
  await postAccepted(service, [createHistogram("latency", [
    histogramPoint(atTime(51), [50, 0, 0, 0], 100, inRegion("eu")),
    histogramPoint(atTime(52), [0, 40, 10, 0], 3_900, inRegion("us")),
  ])]);
  const p95 = await readValues(service, `metric=latency&aggregation=p95&${TWO_STEPS}`);
  assertAlmostEquals(p95[0]!, 550);
});

defineMetricTest("groups and filters by attributes", async (service) => {
  const withAttributes = (model: string, region: string) => ({
    attributes: [stringAttribute("model", model), stringAttribute("region", region)],
  });
  await postAccepted(service, [createSum("tokens", [
    numberPoint(atTime(51), 1, withAttributes("small", "eu")),
    numberPoint(atTime(51), 2, withAttributes("small", "us")),
    numberPoint(atTime(51), 4, withAttributes("large", "eu")),
    numberPoint(atTime(51), 8, { attributes: [] }),
  ], DELTA)]);
  await postAccepted(
    service,
    [createSum("tokens", [numberPoint(atTime(51), 16, withAttributes("small", "eu"))], DELTA)],
    "other-service",
  );

  const byModel = await queryMetric(
    service,
    `metric=tokens&aggregation=sum&${TWO_STEPS}&groupBy=model`,
  );
  assertEquals(byModel.series, [
    { group: { model: "large" }, values: [4, null] },
    { group: { model: "small" }, values: [19, null] },
    { group: { model: null }, values: [8, null] },
  ]);
  const byModelAndRegion = await queryMetric(
    service,
    `metric=tokens&aggregation=sum&${TWO_STEPS}&groupBy=model&groupBy=region`,
  );
  assertEquals(byModelAndRegion.series.length, 4);

  const byService = await queryMetric(
    service,
    `metric=tokens&aggregation=sum&${TWO_STEPS}&groupBy=service.name`,
  );
  assertEquals(byService.series.map(({ group }) => group["service.name"]), [
    "other-service",
    "support-bot",
  ]);

  assertEquals(
    await readValues(
      service,
      `metric=tokens&aggregation=sum&${TWO_STEPS}&attribute=model=small&attribute=region=eu&serviceName=support-bot`,
    ),
    [1, null],
  );
  assertEquals(
    await readValues(
      service,
      `metric=tokens&aggregation=sum&${TWO_STEPS}&serviceName=other-service`,
    ),
    [16, null],
  );
});

defineMetricTest("lists metrics and their attributes", async (service) => {
  await postAccepted(service, [
    createSum("requests", [
      numberPoint(atTime(51), 1, { attributes: [stringAttribute("route", "/a")] }),
      numberPoint(atTime(51), 1, { attributes: [stringAttribute("route", "/b")] }),
    ]),
    createGauge("queue-size", [numberPoint(atTime(51), 1)]),
    createHistogram("latency", [histogramPoint(atTime(51), [1, 0, 0, 0], 1)]),
  ]);
  const { metrics } = await (await sendRequest(service, "/v1/metrics"))
    .json() as ListMetricsResponse;
  assertEquals(metrics.map((metric) => [metric.name, metric.type, metric.seriesCount]), [
    ["latency", "histogram", 1],
    ["queue-size", "gauge", 1],
    ["requests", "sum", 2],
  ]);
  assertEquals(metrics[0].supportedAggregations, ["sum", "avg", "rate", "p95"]);
  assertEquals(metrics[1].supportedAggregations, ["sum", "avg"]);
  assertEquals(metrics[2].supportedAggregations, ["sum", "avg", "rate"]);

  const { attributes } = await (await sendRequest(
    service,
    "/v1/metrics/attributes?metric=requests",
  )).json() as ListMetricAttributesResponse;
  assertEquals(attributes, [
    { key: "route", source: "metric", values: ["/a", "/b"] },
    { key: "service.name", source: "resource", values: ["support-bot"] },
  ]);
});

defineMetricTest("answers why an aggregation or a time range does not work", async (service) => {
  await postAccepted(service, [
    createGauge("queue-size", [numberPoint(atTime(51), 1)]),
    createSum("requests", [numberPoint(atTime(51), 1)]),
  ]);
  const queryError = async (query: string) => {
    const response = await sendRequest(service, `/v1/metrics/query?${query}`);
    assertEquals(response.status, 400);
    return await response.json();
  };
  const rateOfGauge = await queryError(`metric=queue-size&aggregation=rate&${TWO_STEPS}`);
  assertEquals(rateOfGauge.error.code, "unsupported_aggregation");
  assertStringIncludes(rateOfGauge.error.message, "Use sum, avg");
  assertEquals(
    (await queryError(`metric=requests&aggregation=p95&${TWO_STEPS}`)).error.code,
    "unsupported_aggregation",
  );
  assertEquals(
    (await queryError(
      "metric=requests&aggregation=sum&from=2026-11-09T12:00:00Z&to=2026-11-09T11:00:00Z",
    )).error.code,
    "invalid_time_range",
  );
  assertEquals(
    (await queryError(
      "metric=requests&aggregation=sum&from=2026-11-09T00:00:00Z&to=2026-11-09T12:00:00Z&stepSeconds=1",
    )).error.code,
    "too_many_steps",
  );
});

defineMetricTest("refuses to mix types or units under one name", async (service) => {
  await postAccepted(service, [createGauge("size", [numberPoint(atTime(51), 1)])], "first");
  await postAccepted(service, [{
    name: "size",
    unit: "By",
    gauge: { dataPoints: [numberPoint(atTime(51), 1)] },
  }], "second");
  const response = await sendRequest(
    service,
    `/v1/metrics/query?metric=size&aggregation=sum&${TWO_STEPS}`,
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error.code, "ambiguous_metric");
  assertEquals(
    await readValues(service, `metric=size&aggregation=sum&${TWO_STEPS}&serviceName=second`),
    [1, null],
  );
});

defineMetricTest("answers an unknown metric with no series", async (service) => {
  const result = await queryMetric(service, `metric=nothing&aggregation=sum&${TWO_STEPS}`);
  assertEquals(result.metric, null);
  assertEquals(result.series, []);
  assertEquals(result.times, ["2026-11-09T11:50:00.000Z", "2026-11-09T11:55:00.000Z"]);
});

defineMetricTest("chooses a step and keeps a partial last step's rate honest", async (service) => {
  await postAccepted(service, [createSum("sent", [numberPoint(atTime(59), 30)], DELTA)]);
  const result = await queryMetric(
    service,
    "metric=sent&aggregation=rate&from=2026-11-09T11:00:00Z&to=2026-11-09T11:59:30Z",
  );
  assertEquals(result.stepSeconds, 60);
  assertEquals(result.times.length, 60);
  // The last step lasted 30 seconds before the end of the range.
  assertEquals(result.series[0].values.at(-1), 1);
});

defineMetricTest("rejects what it cannot store through partial_success", async (service) => {
  const payload = createRequest([
    createSum("accepted", [numberPoint(atTime(51), 1)], DELTA),
    { name: "exp", exponentialHistogram: { dataPoints: [{ timeUnixNano: atTime(51) }] } },
    {
      name: "quantiles",
      summary: { dataPoints: [{ timeUnixNano: atTime(51) }, { timeUnixNano: atTime(52) }] },
    },
    { unit: "1", gauge: { dataPoints: [numberPoint(atTime(51), 1)] } },
    createSum("no-temporality", [numberPoint(atTime(51), 1)], 0),
    createGauge("no-value", [{ timeUnixNano: atTime(51) }]),
    createGauge("not-finite", [{ timeUnixNano: atTime(51), asDouble: "NaN" }]),
    createGauge("no-time", [{ asDouble: 1 }]),
    createGauge("too-old", [
      numberPoint((NOW_NANOSECONDS - 31n * NANOSECONDS_PER_DAY).toString(), 1),
    ]),
    createHistogram("bad-buckets", [{
      timeUnixNano: atTime(51),
      count: 1,
      bucketCounts: [1],
      explicitBounds: [1, 2],
    }]),
    createHistogram("bad-bounds", [{
      timeUnixNano: atTime(51),
      count: 3,
      bucketCounts: [1, 1, 1],
      explicitBounds: [5, 2],
    }]),
  ]);
  const response = await postJsonMetrics(service, payload);
  assertEquals(response.status, 200);
  const { partialSuccess } = await response.json();
  assertEquals(partialSuccess.rejectedDataPoints, 11);
  assertStringIncludes(partialSuccess.errorMessage, "11 data points rejected");
  assertStringIncludes(partialSuccess.errorMessage, "exponential histograms are not supported (1)");
  assertStringIncludes(partialSuccess.errorMessage, "summaries are not supported (2)");

  assertEquals(await readValues(service, `metric=accepted&aggregation=sum&${TWO_STEPS}`), [
    1,
    null,
  ]);
  const { metrics } = await (await sendRequest(service, "/v1/metrics"))
    .json() as ListMetricsResponse;
  assertEquals(metrics.map((metric) => metric.name), ["accepted"]);

  const rejected = await (await sendRequest(service, "/v1/rejected-telemetry"))
    .json() as RejectedTelemetry;
  assertEquals(rejected.metrics.rejectedCount, 11);
  assertStringIncludes(rejected.metrics.lastReason!, "data points rejected");
  assertEquals(rejected.logs.rejectedCount, 0);
});

defineMetricTest("skips a point flagged as having no recorded value", async (service) => {
  await postAccepted(service, [createGauge("level", [
    numberPoint(atTime(51), 3),
    numberPoint(atTime(52), 99, { flags: 1 }),
  ])]);
  assertEquals(await readValues(service, `metric=level&aggregation=avg&${TWO_STEPS}`), [3, null]);
});

defineMetricTest(
  "stores a retried batch once and keeps attribute order out of it",
  async (service) => {
    const point = (attributes: unknown[]) => numberPoint(atTime(51), 5, { attributes });
    const first = stringAttribute("first", "1");
    const second = stringAttribute("second", "2");
    await postAccepted(service, [createSum("sent", [point([first, second])], DELTA)]);
    await postAccepted(service, [createSum("sent", [point([second, first])], DELTA)]);
    assertEquals(await readValues(service, `metric=sent&aggregation=sum&${TWO_STEPS}`), [5, null]);
    const { metrics } = await (await sendRequest(service, "/v1/metrics"))
      .json() as ListMetricsResponse;
    assertEquals(metrics[0].seriesCount, 1);
  },
);

defineMetricTest("keeps a Project's metrics apart", async (service) => {
  await postAccepted(service, [createSum("sent", [numberPoint(atTime(51), 5)], DELTA)]);
  const result = await queryMetric(
    service,
    `metric=sent&aggregation=sum&${TWO_STEPS}`,
    OTHER_PROJECT_API_KEY,
  );
  assertEquals(result.series, []);
  const unauthenticated = await sendRequest(service, "/v1/metrics", { apiKey: "wrong-key" });
  assertEquals(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();
});

defineMetricTest("stores OTLP/protobuf metrics and answers in protobuf", async (service) => {
  const otlpRoot = protobuf.Root.fromJSON(otlpDescriptor as protobuf.INamespace);
  const requestType = otlpRoot.lookupType(
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
  );
  const responseType = otlpRoot.lookupType(
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse",
  );
  const payload = requestType.encode(requestType.fromObject(createRequest([
    createSum("sent", [{ timeUnixNano: atTime(51), asInt: "7" }], DELTA),
    createHistogram("latency", [{
      timeUnixNano: atTime(51),
      count: "100",
      sum: 4_000,
      bucketCounts: ["50", "40", "10", "0"],
      explicitBounds: BOUNDS,
    }]),
    { name: "exp", exponentialHistogram: { dataPoints: [{ timeUnixNano: atTime(51) }] } },
  ]))).finish();
  const response = await sendRequest(service, "/v1/metrics", {
    method: "POST",
    headers: { "content-type": "application/x-protobuf" },
    body: payload as Uint8Array<ArrayBuffer>,
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/x-protobuf");
  const decoded = responseType.toObject(
    responseType.decode(new Uint8Array(await response.arrayBuffer())),
    { longs: String },
  );
  assertEquals(decoded.partialSuccess.rejectedDataPoints, "1");
  assertEquals(await readValues(service, `metric=sent&aggregation=sum&${TWO_STEPS}`), [7, null]);
  const p95 = await readValues(service, `metric=latency&aggregation=p95&${TWO_STEPS}`);
  assertAlmostEquals(p95[0]!, 550);
});

const METRIC_PARTITION_PATTERN = /^metric_points_\d{8}$/;

async function listMetricPartitionNames(database: TelemetryDatabase): Promise<string[]> {
  const rows = await database.orm.em.fork().execute<{ partition_name: string }[]>(
    `select child.relname as partition_name
      from pg_inherits
      join pg_class parent on pg_inherits.inhparent = parent.oid
      join pg_class child on pg_inherits.inhrelid = child.oid
      where parent.relname = 'metric_points'
      order by child.relname`,
  );
  return rows.map((row) => row.partition_name).filter((name) =>
    METRIC_PARTITION_PATTERN.test(name)
  );
}

async function dropMetricPartitions(database: TelemetryDatabase): Promise<void> {
  for (const partitionName of await listMetricPartitionNames(database)) {
    await database.orm.em.fork().execute(`drop table "${partitionName}"`);
  }
}

for (const testDatabase of listTestDatabases("telemetry")) {
  if (testDatabase.label !== "postgresql") continue;
  Deno.test("replicas racing to create one day's metric partition all succeed (postgresql)", async () => {
    const databases = await Promise.all(
      Array.from({ length: 8 }, () => openTelemetryDatabase(testDatabase.url)),
    );
    try {
      await clearMetrics(databases[0]);
      await dropMetricPartitions(databases[0]);
      // Each service has its own memory of known partitions, as separate replicas have.
      const responses = await Promise.all(databases.map((database, replicaIndex) =>
        postJsonMetrics(
          createService(database),
          createRequest([createSum(`replica-${replicaIndex}`, [
            numberPoint(atTime(51), 1),
          ], DELTA)]),
        )
      ));
      for (const response of responses) {
        assertEquals(response.status, 200, await response.text());
      }
      assertEquals(await listMetricPartitionNames(databases[0]), ["metric_points_20261109"]);
    } finally {
      await Promise.all(databases.map((database) => database.close()));
    }
  });

  Deno.test("a metric query reads only the partitions it overlaps (postgresql)", async () => {
    const database = await openTelemetryDatabase(testDatabase.url);
    try {
      await clearMetrics(database);
      await dropMetricPartitions(database);
      const service = createService(database);
      await postAccepted(service, [createSum("sent", [
        numberPoint((NOW_NANOSECONDS - NANOSECONDS_PER_DAY).toString(), 1),
        numberPoint(atTime(51), 1),
      ], DELTA)]);
      assertEquals(await listMetricPartitionNames(database), [
        "metric_points_20261108",
        "metric_points_20261109",
      ]);
      const rows = await database.orm.em.fork().execute<Record<string, string>[]>(
        `explain select * from metric_points
          where project_id = 'project-one'
            and time_unix_nano >= '${atTime(50).padStart(20, "0")}'
            and time_unix_nano < '${NOW_NANOSECONDS.toString().padStart(20, "0")}'`,
      );
      const plan = rows.map((row) => Object.values(row).join(" ")).join("\n");
      assert(
        !plan.includes("metric_points_20261108"),
        `The plan reads yesterday's partition:\n${plan}`,
      );
    } finally {
      await database.close();
    }
  });
}
