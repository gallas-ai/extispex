/**
 * Metrics from the OpenTelemetry SDK, over every OTLP transport, read back through the Gateway as
 * sums, rates, averages and percentiles, cumulative and delta alike.
 */
import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  ListMetricsResponse,
  QueryMetricResponse,
  RejectedTelemetry,
} from "@extispex/contracts";
import * as grpc from "@grpc/grpc-js";
import { Buffer } from "node:buffer";
import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter as JsonMetricExporter,
} from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as ProtobufMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { type RunningDeployment, startDeployment } from "./deployment.ts";

const E2E_SERVICE_NAME = "e2e-metric-writer";
/** An hour is longer than any test runs, and one step covers the export interval. */
const EXPORT_INTERVAL_MILLISECONDS = 3_600_000;

function createMeterProvider(metricExporter: PushMetricExporter): MeterProvider {
  return new MeterProvider({
    resource: resourceFromAttributes({ "service.name": E2E_SERVICE_NAME }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: EXPORT_INTERVAL_MILLISECONDS,
      }),
    ],
  });
}

/** A counter in two exports and a histogram, as an application records them. */
async function recordMetrics(metricExporter: PushMetricExporter, prefix: string): Promise<void> {
  const meterProvider = createMeterProvider(metricExporter);
  const meter = meterProvider.getMeter("e2e");
  const requests = meter.createCounter(`${prefix}.requests`, { unit: "{request}" });
  const latency = meter.createHistogram(`${prefix}.latency`, {
    unit: "ms",
    advice: { explicitBucketBoundaries: [10, 100, 1000] },
  });
  const queueSize = meter.createGauge(`${prefix}.queue_size`);
  requests.add(3, { "gen_ai.request.model": "model-one" });
  requests.add(4, { "gen_ai.request.model": "model-two" });
  for (let observationIndex = 0; observationIndex < 90; observationIndex++) {
    latency.record(5);
  }
  for (let observationIndex = 0; observationIndex < 10; observationIndex++) {
    latency.record(500);
  }
  queueSize.record(12);
  await meterProvider.forceFlush();
  // The second export repeats a cumulative counter's total, which the query turns into increases.
  requests.add(2, { "gen_ai.request.model": "model-one" });
  await meterProvider.forceFlush();
  await meterProvider.shutdown();
}

async function queryMetric(
  deployment: RunningDeployment,
  query: string,
): Promise<QueryMetricResponse> {
  const from = new Date(Date.now() - 15 * 60_000).toISOString();
  const response = await fetch(
    `${deployment.gatewayUrl}/v1/metrics/query?${query}&from=${from}`,
    { headers: { authorization: `Bearer ${deployment.apiKey}` } },
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as QueryMetricResponse;
}

function addUp(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function readOnlyValue(values: (number | null)[]): number {
  const presentValues = values.filter((value): value is number => value !== null);
  assertEquals(presentValues.length, 1, `expected one value, got ${presentValues}`);
  return presentValues[0];
}

async function assertMetricsStored(deployment: RunningDeployment, prefix: string) {
  const byModel = await queryMetric(
    deployment,
    `metric=${prefix}.requests&aggregation=sum&groupBy=gen_ai.request.model`,
  );
  assertEquals(byModel.metric?.type, "sum");
  assertEquals(
    byModel.series.map(({ group, values }) => [group["gen_ai.request.model"], addUp(values)]),
    [["model-one", 5], ["model-two", 4]],
  );
  const rate = await queryMetric(deployment, `metric=${prefix}.requests&aggregation=rate`);
  assert(addUp(rate.series[0].values) > 0, "The counter has no rate.");

  const p95 = await queryMetric(deployment, `metric=${prefix}.latency&aggregation=p95`);
  assertAlmostEquals(readOnlyValue(p95.series[0].values), 550);
  const average = await queryMetric(deployment, `metric=${prefix}.latency&aggregation=avg`);
  assertAlmostEquals(readOnlyValue(average.series[0].values), 54.5);

  const gauge = await queryMetric(deployment, `metric=${prefix}.queue_size&aggregation=avg`);
  assertEquals(readOnlyValue(gauge.series[0].values), 12);
}

function createGrpcExporter(deployment: RunningDeployment): GrpcMetricExporter {
  const grpcMetadata = new grpc.Metadata();
  grpcMetadata.set("authorization", `Bearer ${deployment.apiKey}`);
  const usesTls = deployment.grpcRootCertificate !== null;
  return new GrpcMetricExporter({
    url: `${usesTls ? "https" : "http"}://${deployment.otlpGrpcAddress}`,
    credentials: usesTls
      ? grpc.credentials.createSsl(Buffer.from(deployment.grpcRootCertificate as Uint8Array))
      : grpc.credentials.createInsecure(),
    metadata: grpcMetadata,
  });
}

Deno.test("metric pipeline", async (testContext) => {
  const deployment = await startDeployment();
  const authorizationHeaders = { authorization: `Bearer ${deployment.apiKey}` };
  // Separate services keep one database for the whole run, so the names must be this test's own.
  const runPrefix = `e2e${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const readRejectedTelemetry = async () =>
    await (await fetch(`${deployment.gatewayUrl}/v1/rejected-telemetry`, {
      headers: authorizationHeaders,
    })).json() as RejectedTelemetry;
  try {
    const exportersByName: [string, string, () => PushMetricExporter][] = [
      [
        "OTLP/HTTP protobuf, cumulative",
        `${runPrefix}.protobuf`,
        () =>
          new ProtobufMetricExporter({
            url: `${deployment.otlpHttpUrl}/v1/metrics`,
            headers: authorizationHeaders,
          }),
      ],
      [
        "OTLP/HTTP JSON, delta",
        `${runPrefix}.json`,
        () =>
          new JsonMetricExporter({
            url: `${deployment.otlpHttpUrl}/v1/metrics`,
            headers: authorizationHeaders,
            temporalityPreference: AggregationTemporalityPreference.DELTA,
          }),
      ],
      ["OTLP/gRPC, cumulative", `${runPrefix}.grpc`, () => createGrpcExporter(deployment)],
    ];
    for (const [exporterName, prefix, createExporter] of exportersByName) {
      await testContext.step(`reads metrics sent over ${exporterName}`, async () => {
        await recordMetrics(createExporter(), prefix);
        await assertMetricsStored(deployment, prefix);
      });
    }

    await testContext.step("lists the metrics with what each can be aggregated by", async () => {
      const response = await fetch(`${deployment.gatewayUrl}/v1/metrics`, {
        headers: authorizationHeaders,
      });
      const { metrics } = await response.json() as ListMetricsResponse;
      const latency = metrics.find((metric) => metric.name === `${runPrefix}.grpc.latency`);
      assertEquals(latency?.supportedAggregations, ["sum", "avg", "rate", "p95"]);
      const gauge = metrics.find((metric) => metric.name === `${runPrefix}.grpc.queue_size`);
      assertEquals(gauge?.supportedAggregations, ["sum", "avg"]);
    });

    await testContext.step("rejects summaries and counts them", async () => {
      const rejectedBefore = (await readRejectedTelemetry()).metrics.rejectedCount;
      const nowNanoseconds = BigInt(Date.now()) * 1_000_000n;
      const response = await fetch(`${deployment.otlpHttpUrl}/v1/metrics`, {
        method: "POST",
        headers: { ...authorizationHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          resourceMetrics: [{
            scopeMetrics: [{
              metrics: [{
                name: `${runPrefix}.summary`,
                summary: { dataPoints: [{ timeUnixNano: `${nowNanoseconds}` }] },
              }],
            }],
          }],
        }),
      });
      const { partialSuccess } = await response.json();
      assertEquals(partialSuccess.rejectedDataPoints, 1);
      const rejected = await readRejectedTelemetry();
      assertEquals(rejected.metrics.rejectedCount, rejectedBefore + 1);
      assertStringIncludes(rejected.metrics.lastReason ?? "", "summaries are not supported");
    });

    await testContext.step("explains an aggregation that does not apply", async () => {
      const response = await fetch(
        `${deployment.gatewayUrl}/v1/metrics/query?metric=${runPrefix}.grpc.queue_size&aggregation=rate`,
        { headers: authorizationHeaders },
      );
      assertEquals(response.status, 400);
      assertEquals((await response.json()).error.code, "unsupported_aggregation");
    });
  } finally {
    await deployment.stop();
  }
});
