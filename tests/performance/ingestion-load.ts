/**
 * Ingestion throughput: several senders, each like one instrumented process, send a fixed number
 * of OTLP/JSON requests to Telemetry's OTLP/HTTP endpoint. The amount of data is fixed, so that the
 * queries that follow read the same amount in every run.
 */
import type { RunningDeployment } from "@extispex/e2e-tests";
import type { Measurement } from "./performance-results.ts";
import { type LoadClient, randomHex, runSenders } from "./load-client.ts";

export interface IngestionSettings {
  senderCount: number;
  /** Unmeasured requests per sender first, so that connections, caches and partitions exist. */
  warmUpRequestsPerSender: number;
  requestsPerSender: number;
}

/** What the queries later look for. */
export interface IngestedData {
  traces: { traceId: string; correlationId: string }[];
  /** A word that appears in every fifth log record's body. */
  logSearchWord: string;
  /** The time range that holds every metric data point. */
  metricTimeRange: { from: Date; to: Date };
}

interface IngestionScenario {
  id: string;
  description: string;
  unit: string;
  otlpPath: "/v1/traces" | "/v1/logs" | "/v1/metrics";
  recordsPerRequest: number;
  buildRequestBody(senderIndex: number, requestIndex: number): unknown;
}

const SPANS_PER_TRACE = 4;
const TRACES_PER_REQUEST = 25;
const LOG_RECORDS_PER_REQUEST = 100;
const METRIC_ROUTES = 20;
const GAUGE_QUEUES = 10;
/** Each request stands for one export interval of a process's metrics. */
const METRIC_EXPORT_INTERVAL_SECONDS = 10;
const HISTOGRAM_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1_000];
const LOG_WORDS = ["shipped", "packed", "delayed", "cancelled", "refunded"];
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
/** Remembered traces, enough for the queries to pick a different one for each sample. */
const REMEMBERED_TRACES_PER_REQUEST = 1;

export async function measureIngestion(
  deployment: RunningDeployment,
  loadClient: LoadClient,
  settings: IngestionSettings,
): Promise<{ measurements: Measurement[]; ingestedData: IngestedData }> {
  const totalRequestsPerSender = settings.warmUpRequestsPerSender + settings.requestsPerSender;
  const metricBaseMilliseconds = Date.now() -
    (totalRequestsPerSender + 6) * METRIC_EXPORT_INTERVAL_SECONDS * 1_000;
  const ingestedData: IngestedData = {
    traces: [],
    logSearchWord: "refunded",
    metricTimeRange: {
      from: new Date(metricBaseMilliseconds - 60_000),
      to: new Date(Date.now() + 60_000),
    },
  };
  const scenarios = [
    createSpanScenario(ingestedData),
    createLogScenario(),
    createMetricScenario(metricBaseMilliseconds),
  ];
  const measurements: Measurement[] = [];
  for (const scenario of scenarios) {
    measurements.push(await runIngestionScenario(deployment, loadClient, settings, scenario));
  }
  return { measurements, ingestedData };
}

async function runIngestionScenario(
  deployment: RunningDeployment,
  loadClient: LoadClient,
  settings: IngestionSettings,
  scenario: IngestionScenario,
): Promise<Measurement> {
  const sendRequests = (firstRequestIndex: number, requestCount: number) =>
    runSenders(settings.senderCount, async (senderIndex) => {
      for (let requestOffset = 0; requestOffset < requestCount; requestOffset++) {
        const requestBody = scenario.buildRequestBody(
          senderIndex,
          firstRequestIndex + requestOffset,
        );
        await sendOtlpRequest(deployment, loadClient, scenario.otlpPath, requestBody);
      }
    });
  await sendRequests(0, settings.warmUpRequestsPerSender);
  const startedAt = performance.now();
  await sendRequests(settings.warmUpRequestsPerSender, settings.requestsPerSender);
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const recordCount = settings.senderCount * settings.requestsPerSender *
    scenario.recordsPerRequest;
  return {
    id: scenario.id,
    description: scenario.description,
    kind: "throughput",
    unit: scenario.unit,
    value: Math.round(recordCount / elapsedSeconds),
  };
}

/** Fails the run when Telemetry refuses the request or rejects any record in it. */
async function sendOtlpRequest(
  deployment: RunningDeployment,
  loadClient: LoadClient,
  otlpPath: string,
  requestBody: unknown,
): Promise<void> {
  const response = await loadClient.send(`${deployment.otlpHttpUrl}${otlpPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deployment.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const responseText = await response.text();
  if (response.status !== 200) {
    throw new Error(`OTLP ${otlpPath} answered ${response.status}: ${responseText}`);
  }
  const partialSuccess = (JSON.parse(responseText || "{}") as {
    partialSuccess?: Record<string, unknown>;
  }).partialSuccess ?? {};
  const rejectedCount = Object.entries(partialSuccess)
    .filter(([fieldName]) => fieldName.startsWith("rejected"))
    .reduce((total, [, fieldValue]) => total + Number(fieldValue ?? 0), 0);
  if (rejectedCount > 0) {
    throw new Error(`OTLP ${otlpPath} rejected ${rejectedCount} records: ${responseText}`);
  }
}

function toAttributes(attributes: Record<string, string | number>) {
  return Object.entries(attributes).map(([key, attributeValue]) => ({
    key,
    value: typeof attributeValue === "number"
      ? { intValue: String(attributeValue) }
      : { stringValue: attributeValue },
  }));
}

function createResource(senderIndex: number) {
  return {
    attributes: toAttributes({
      "service.name": "performance-support-bot",
      "service.instance.id": `sender-${senderIndex}`,
    }),
  };
}

function createSpanScenario(ingestedData: IngestedData): IngestionScenario {
  return {
    id: "span-ingestion",
    description: "Span ingestion",
    unit: "spans/s",
    otlpPath: "/v1/traces",
    recordsPerRequest: TRACES_PER_REQUEST * SPANS_PER_TRACE,
    buildRequestBody(senderIndex, requestIndex) {
      const startNanoseconds = BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND;
      const spans = [];
      for (let traceIndex = 0; traceIndex < TRACES_PER_REQUEST; traceIndex++) {
        const traceId = randomHex(16);
        const correlationId = `performance-${senderIndex}-${requestIndex}-${traceIndex}`;
        if (traceIndex < REMEMBERED_TRACES_PER_REQUEST) {
          ingestedData.traces.push({ traceId, correlationId });
        }
        const rootSpanId = randomHex(8);
        const spanOf = (name: string, offsetMilliseconds: number, parentSpanId?: string) => ({
          traceId,
          spanId: parentSpanId === undefined ? rootSpanId : randomHex(8),
          parentSpanId,
          name,
          kind: parentSpanId === undefined ? 2 : 1,
          startTimeUnixNano: String(
            startNanoseconds + BigInt(offsetMilliseconds) * NANOSECONDS_PER_MILLISECOND,
          ),
          endTimeUnixNano: String(
            startNanoseconds + BigInt(offsetMilliseconds + 40) * NANOSECONDS_PER_MILLISECOND,
          ),
          attributes: toAttributes({
            "correlation.id": correlationId,
            "session.id": `performance-session-${senderIndex}-${requestIndex}`,
            "gen_ai.request.model": "gpt-performance",
            "gen_ai.usage.input_tokens": 120 + traceIndex,
          }),
          status: { code: 1 },
        });
        spans.push(
          spanOf("handle-message", 0),
          spanOf("retrieve-documents", 2, rootSpanId),
          spanOf("chat gpt-performance", 10, rootSpanId),
          spanOf("execute_tool", 30, rootSpanId),
        );
      }
      return {
        resourceSpans: [{
          resource: createResource(senderIndex),
          scopeSpans: [{ scope: { name: "performance-test" }, spans }],
        }],
      };
    },
  };
}

function createLogScenario(): IngestionScenario {
  return {
    id: "log-ingestion",
    description: "Log record ingestion",
    unit: "records/s",
    otlpPath: "/v1/logs",
    recordsPerRequest: LOG_RECORDS_PER_REQUEST,
    buildRequestBody(senderIndex, requestIndex) {
      const timeNanoseconds = BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND;
      const logRecords = Array.from({ length: LOG_RECORDS_PER_REQUEST }, (_, recordIndex) => {
        const orderNumber = requestIndex * LOG_RECORDS_PER_REQUEST + recordIndex;
        const severityNumber = recordIndex % 10 === 0 ? 17 : recordIndex % 4 === 0 ? 13 : 9;
        return {
          timeUnixNano: String(timeNanoseconds + BigInt(recordIndex)),
          severityNumber,
          severityText: severityNumber === 17 ? "ERROR" : severityNumber === 13 ? "WARN" : "INFO",
          body: {
            stringValue: `Order ${orderNumber} of customer ${recordIndex % 37} was ${
              LOG_WORDS[recordIndex % LOG_WORDS.length]
            } at warehouse ${senderIndex}`,
          },
          attributes: toAttributes({ "order.channel": recordIndex % 2 === 0 ? "web" : "chat" }),
        };
      });
      return {
        resourceLogs: [{
          resource: createResource(senderIndex),
          scopeLogs: [{ scope: { name: "performance-test" }, logRecords }],
        }],
      };
    },
  };
}

function createMetricScenario(metricBaseMilliseconds: number): IngestionScenario {
  return {
    id: "metric-ingestion",
    description: "Metric data point ingestion",
    unit: "points/s",
    otlpPath: "/v1/metrics",
    recordsPerRequest: METRIC_ROUTES * 2 + GAUGE_QUEUES,
    buildRequestBody(senderIndex, requestIndex) {
      const nanosecondsAt = (milliseconds: number) =>
        String(BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND);
      const startTimeUnixNano = nanosecondsAt(metricBaseMilliseconds - 1_000);
      const timeUnixNano = nanosecondsAt(
        metricBaseMilliseconds + requestIndex * METRIC_EXPORT_INTERVAL_SECONDS * 1_000,
      );
      const intervalCount = requestIndex + 1;
      const routeAttributes = (routeIndex: number) =>
        toAttributes({
          "http.route": `/route-${String(routeIndex).padStart(2, "0")}`,
          status: routeIndex % 5 === 0 ? "error" : "ok",
        });
      const routeIndexes = Array.from({ length: METRIC_ROUTES }, (_, routeIndex) => routeIndex);
      return {
        resourceMetrics: [{
          resource: createResource(senderIndex),
          scopeMetrics: [{
            scope: { name: "performance-test" },
            metrics: [
              {
                name: "performance.requests",
                unit: "{request}",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: routeIndexes.map((routeIndex) => ({
                    attributes: routeAttributes(routeIndex),
                    startTimeUnixNano,
                    timeUnixNano,
                    asInt: String(intervalCount * (routeIndex + 1)),
                  })),
                },
              },
              {
                name: "performance.request.duration",
                unit: "ms",
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: routeIndexes.map((routeIndex) => {
                    // Every interval adds one observation to each bucket and one above the last.
                    const bucketCounts = [...HISTOGRAM_BOUNDS, Infinity].map(() =>
                      String(intervalCount)
                    );
                    return {
                      attributes: routeAttributes(routeIndex),
                      startTimeUnixNano,
                      timeUnixNano,
                      count: String(intervalCount * bucketCounts.length),
                      sum: intervalCount * 2_500,
                      bucketCounts,
                      explicitBounds: HISTOGRAM_BOUNDS,
                    };
                  }),
                },
              },
              {
                name: "performance.queue.size",
                unit: "{job}",
                gauge: {
                  dataPoints: Array.from({ length: GAUGE_QUEUES }, (_, queueIndex) => ({
                    attributes: toAttributes({ queue: `queue-${queueIndex}` }),
                    timeUnixNano,
                    asDouble: (requestIndex * 7 + queueIndex) % 50,
                  })),
                },
              },
            ],
          }],
        }],
      };
    },
  };
}
