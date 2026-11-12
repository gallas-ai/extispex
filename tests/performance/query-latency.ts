/**
 * Query latency: the queries the web UI sends, one after another through the Gateway, over the
 * data that the ingestion phase stored. Every query runs in several passes, one query after the
 * other in each pass, and its lowest p95 of a pass is the measurement: a shared runner's hiccups
 * only ever make a pass slower.
 */
import type { RunningDeployment } from "@extispex/e2e-tests";
import type { IngestedData } from "./ingestion-load.ts";
import { computePercentile, type LoadClient } from "./load-client.ts";
import type { Measurement } from "./performance-results.ts";

export interface QuerySettings {
  passCount: number;
  /** Unmeasured requests of each query at the start of each pass. */
  warmUpRequests: number;
  measuredRequests: number;
}

interface QueryScenario {
  id: string;
  description: string;
  /** The Gateway path and query string for one sample. */
  buildPath(sampleIndex: number): string;
}

export async function measureQueryLatency(
  deployment: RunningDeployment,
  loadClient: LoadClient,
  ingestedData: IngestedData,
  settings: QuerySettings,
): Promise<Measurement[]> {
  const pickTrace = (sampleIndex: number) =>
    ingestedData.traces[(sampleIndex * 7919) % ingestedData.traces.length];
  const metricRange = new URLSearchParams({
    from: ingestedData.metricTimeRange.from.toISOString(),
    to: ingestedData.metricTimeRange.to.toISOString(),
  });
  const logRange = new URLSearchParams({
    from: new Date(Date.now() - 3_600_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  });
  const scenarios: QueryScenario[] = [
    {
      id: "list-traces-p95",
      description: "Newest 50 traces, p95",
      buildPath: () => "/v1/traces?limit=50",
    },
    {
      id: "trace-detail-p95",
      description: "One trace with its spans, p95",
      buildPath: (sampleIndex) => `/v1/traces/${pickTrace(sampleIndex).traceId}`,
    },
    {
      id: "traces-by-correlation-p95",
      description: "Traces of one Correlation ID, p95",
      buildPath: (sampleIndex) =>
        `/v1/traces?correlationId=${encodeURIComponent(pickTrace(sampleIndex).correlationId)}`,
    },
    {
      id: "log-search-p95",
      description: "Log search for a word in the last hour, p95",
      buildPath: () => `/v1/logs?search=${ingestedData.logSearchWord}&limit=100&${logRange}`,
    },
    {
      id: "metric-histogram-p95-query-p95",
      description: "Histogram p95 grouped by an attribute, p95",
      buildPath: () =>
        `/v1/metrics/query?metric=performance.request.duration&aggregation=p95&groupBy=status&${metricRange}`,
    },
    {
      id: "metric-rate-query-p95",
      description: "Counter rate, p95",
      buildPath: () =>
        `/v1/metrics/query?metric=performance.requests&aggregation=rate&${metricRange}`,
    },
  ];
  const passPercentiles = new Map<string, number[]>();
  for (let passIndex = 0; passIndex < settings.passCount; passIndex++) {
    for (const scenario of scenarios) {
      const durations = await sampleQuery(deployment, loadClient, scenario, settings);
      passPercentiles.set(scenario.id, [
        ...(passPercentiles.get(scenario.id) ?? []),
        computePercentile(durations, 0.95),
      ]);
    }
  }
  return scenarios.map((scenario) => ({
    id: scenario.id,
    description: `${scenario.description}, best of ${settings.passCount} passes`,
    kind: "latency",
    unit: "ms",
    value: Math.round(Math.min(...passPercentiles.get(scenario.id)!) * 10) / 10,
  }));
}

/** The durations of one pass's measured requests of a query, in milliseconds. */
async function sampleQuery(
  deployment: RunningDeployment,
  loadClient: LoadClient,
  scenario: QueryScenario,
  settings: QuerySettings,
): Promise<number[]> {
  const durations: number[] = [];
  for (
    let sampleIndex = 0;
    sampleIndex < settings.warmUpRequests + settings.measuredRequests;
    sampleIndex++
  ) {
    const startedAt = performance.now();
    const response = await loadClient.send(
      `${deployment.gatewayUrl}${scenario.buildPath(sampleIndex)}`,
      { headers: { authorization: `Bearer ${deployment.apiKey}` } },
    );
    const responseText = await response.text();
    const elapsedMilliseconds = performance.now() - startedAt;
    if (response.status !== 200) {
      throw new Error(`${scenario.description} answered ${response.status}: ${responseText}`);
    }
    if (sampleIndex === 0 && !hasResults(JSON.parse(responseText))) {
      throw new Error(`${scenario.description} found nothing: ${responseText}`);
    }
    if (sampleIndex >= settings.warmUpRequests) durations.push(elapsedMilliseconds);
  }
  return durations;
}

/** Whether a query answer holds data, so that a fast empty answer cannot pass as a fast query. */
function hasResults(responseBody: Record<string, unknown>): boolean {
  return ["traces", "spans", "logs", "series"].some((fieldName) => {
    const fieldValue = responseBody[fieldName];
    return Array.isArray(fieldValue) && fieldValue.length > 0;
  });
}
