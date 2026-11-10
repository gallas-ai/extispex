import { createHash } from "node:crypto";
import type {
  OtlpExportMetricsRequest,
  OtlpHistogramDataPoint,
  OtlpMetric,
  OtlpNumberDataPoint,
} from "./otlp-metric-types.ts";
import { convertEnumValue, convertKeyValues, parseUnixNanoseconds } from "./otlp-values.ts";
import { findTimeWindowRejection } from "./record-time-window.ts";
import { makeTextStorable, makeValueStorable } from "./stored-text.ts";

export type MetricType = "sum" | "gauge" | "histogram";
export type MetricTemporality = "delta" | "cumulative";

/** One Time Series: what its points share, stored once instead of on every point. */
export interface IncomingMetricSeries {
  seriesId: string;
  metricName: string;
  metricType: MetricType;
  unit: string;
  temporality: MetricTemporality | null;
  isMonotonic: boolean | null;
  /** Upper bounds of a histogram's buckets. A series with other bounds is another series. */
  explicitBounds: number[] | null;
  serviceName: string | null;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  lastSeenUnixNano: bigint;
}

export interface IncomingHistogramValue {
  count: number;
  sum: number | null;
  /** One count per bucket: one more than the bounds, the last being the overflow bucket. */
  bucketCounts: number[];
}

export interface IncomingMetricPoint {
  seriesId: string;
  timeUnixNano: bigint;
  startTimeUnixNano: bigint | null;
  /** The value of a sum or a gauge. */
  value: number | null;
  histogram: IncomingHistogramValue | null;
}

export interface MetricNormalizationResult {
  series: IncomingMetricSeries[];
  points: IncomingMetricPoint[];
  /** One entry per rejected data point: why it was rejected. */
  rejectionReasons: string[];
}

interface MetricDefinition {
  metricName: string;
  metricType: MetricType;
  unit: string;
  temporality: MetricTemporality | null;
  isMonotonic: boolean | null;
}

interface ResourceContext {
  scopeName: string;
  scopeVersion: string;
  serviceName: string | null;
  resourceAttributes: Record<string, unknown>;
  receivedUnixNanoseconds: bigint;
}

type TemporalityOrUnspecified = MetricTemporality | "unspecified";

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const SERVICE_NAME_RESOURCE_ATTRIBUTE = "service.name";
/** OpenTelemetry's limit for an instrument name. The name is indexed, so it must stay bounded. */
const MAXIMUM_METRIC_NAME_LENGTH = 255;
const NO_RECORDED_VALUE_FLAG = 1;
const TEMPORALITIES_BY_NUMBER: Record<number, TemporalityOrUnspecified> = {
  0: "unspecified",
  1: "delta",
  2: "cumulative",
};

export function normalizeMetricsRequest(
  request: OtlpExportMetricsRequest,
  receivedAt: Date,
): MetricNormalizationResult {
  const seriesById = new Map<string, IncomingMetricSeries>();
  const points: IncomingMetricPoint[] = [];
  const rejectionReasons: string[] = [];
  const receivedUnixNanoseconds = BigInt(receivedAt.getTime()) * NANOSECONDS_PER_MILLISECOND;

  for (const resourceMetrics of request.resourceMetrics ?? []) {
    const resourceAttributes = makeValueStorable(
      convertKeyValues(resourceMetrics.resource?.attributes),
    ) as Record<string, unknown>;
    const serviceNameAttribute = resourceAttributes[SERVICE_NAME_RESOURCE_ATTRIBUTE];
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      const resourceContext: ResourceContext = {
        scopeName: scopeMetrics.scope?.name ?? "",
        scopeVersion: scopeMetrics.scope?.version ?? "",
        serviceName: typeof serviceNameAttribute === "string" ? serviceNameAttribute : null,
        resourceAttributes,
        receivedUnixNanoseconds,
      };
      for (const metric of scopeMetrics.metrics ?? []) {
        normalizeMetric(metric, resourceContext, seriesById, points, rejectionReasons);
      }
    }
  }
  return { series: [...seriesById.values()], points, rejectionReasons };
}

function normalizeMetric(
  metric: OtlpMetric,
  resourceContext: ResourceContext,
  seriesById: Map<string, IncomingMetricSeries>,
  points: IncomingMetricPoint[],
  rejectionReasons: string[],
): void {
  const rejectEveryPoint = (reason: string) => {
    for (const _dataPoint of listDataPoints(metric)) rejectionReasons.push(reason);
  };
  if (metric.exponentialHistogram !== undefined) {
    rejectEveryPoint("exponential histograms are not supported");
    return;
  }
  if (metric.summary !== undefined) {
    rejectEveryPoint("summaries are not supported");
    return;
  }
  if (!metric.name) {
    rejectEveryPoint("the metric has no name");
    return;
  }
  const metricName = makeTextStorable(metric.name);
  if (metricName.length > MAXIMUM_METRIC_NAME_LENGTH) {
    rejectEveryPoint(`the metric name is longer than ${MAXIMUM_METRIC_NAME_LENGTH} characters`);
    return;
  }
  const unit = makeTextStorable(metric.unit ?? "");
  const addOutcome = (outcome: NormalizedPoint | string | null) => {
    if (outcome === null) return;
    if (typeof outcome === "string") {
      rejectionReasons.push(outcome);
      return;
    }
    const knownSeries = seriesById.get(outcome.series.seriesId);
    if (knownSeries === undefined) {
      seriesById.set(outcome.series.seriesId, outcome.series);
    } else if (outcome.point.timeUnixNano > knownSeries.lastSeenUnixNano) {
      knownSeries.lastSeenUnixNano = outcome.point.timeUnixNano;
    }
    points.push(outcome.point);
  };

  if (metric.gauge !== undefined) {
    const definition: MetricDefinition = {
      metricName,
      metricType: "gauge",
      unit,
      temporality: null,
      isMonotonic: null,
    };
    for (const dataPoint of metric.gauge.dataPoints ?? []) {
      addOutcome(normalizeNumberPoint(dataPoint, definition, resourceContext));
    }
    return;
  }
  if (metric.sum !== undefined) {
    const temporality = convertTemporality(metric.sum.aggregationTemporality);
    if (temporality === null) {
      rejectEveryPoint("the aggregation temporality is unspecified");
      return;
    }
    const definition: MetricDefinition = {
      metricName,
      metricType: "sum",
      unit,
      temporality,
      isMonotonic: metric.sum.isMonotonic === true,
    };
    for (const dataPoint of metric.sum.dataPoints ?? []) {
      addOutcome(normalizeNumberPoint(dataPoint, definition, resourceContext));
    }
    return;
  }
  if (metric.histogram !== undefined) {
    const temporality = convertTemporality(metric.histogram.aggregationTemporality);
    if (temporality === null) {
      rejectEveryPoint("the aggregation temporality is unspecified");
      return;
    }
    const definition: MetricDefinition = {
      metricName,
      metricType: "histogram",
      unit,
      temporality,
      isMonotonic: null,
    };
    for (const dataPoint of metric.histogram.dataPoints ?? []) {
      addOutcome(normalizeHistogramPoint(dataPoint, definition, resourceContext));
    }
  }
}

function listDataPoints(metric: OtlpMetric): unknown[] {
  return metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? metric.histogram?.dataPoints ??
    metric.exponentialHistogram?.dataPoints ?? metric.summary?.dataPoints ?? [];
}

function convertTemporality(rawValue: number | string | undefined): MetricTemporality | null {
  const temporality = convertEnumValue<TemporalityOrUnspecified>(
    rawValue,
    TEMPORALITIES_BY_NUMBER,
    "AGGREGATION_TEMPORALITY_",
    "unspecified",
  );
  return temporality === "unspecified" ? null : temporality;
}

interface NormalizedPoint {
  series: IncomingMetricSeries;
  point: IncomingMetricPoint;
}

function normalizeNumberPoint(
  dataPoint: OtlpNumberDataPoint,
  definition: MetricDefinition,
  resourceContext: ResourceContext,
): NormalizedPoint | string | null {
  if (hasNoRecordedValue(dataPoint.flags)) return null;
  const pointTimes = readPointTimes(dataPoint, resourceContext.receivedUnixNanoseconds);
  if (typeof pointTimes === "string") return pointTimes;
  const value = readFiniteNumber(dataPoint.asDouble ?? dataPoint.asInt);
  if (value === null) return "the value is missing or not a finite number";
  const series = createSeries(dataPoint, definition, resourceContext, null, pointTimes.time);
  return {
    series,
    point: {
      seriesId: series.seriesId,
      timeUnixNano: pointTimes.time,
      startTimeUnixNano: pointTimes.start,
      value,
      histogram: null,
    },
  };
}

function normalizeHistogramPoint(
  dataPoint: OtlpHistogramDataPoint,
  definition: MetricDefinition,
  resourceContext: ResourceContext,
): NormalizedPoint | string | null {
  if (hasNoRecordedValue(dataPoint.flags)) return null;
  const pointTimes = readPointTimes(dataPoint, resourceContext.receivedUnixNanoseconds);
  if (typeof pointTimes === "string") return pointTimes;
  const count = readFiniteNumber(dataPoint.count);
  if (count === null || count < 0) return "the histogram count is missing or invalid";
  const sum = dataPoint.sum === undefined ? null : readFiniteNumber(dataPoint.sum);
  if (dataPoint.sum !== undefined && sum === null) {
    return "the histogram sum is not a finite number";
  }
  const explicitBounds = (dataPoint.explicitBounds ?? []).map(Number);
  const areBoundsIncreasing = explicitBounds.every((bound, boundIndex) =>
    Number.isFinite(bound) && (boundIndex === 0 || bound > explicitBounds[boundIndex - 1])
  );
  if (!areBoundsIncreasing) return "the histogram bounds are not finite and increasing";
  const bucketCounts = (dataPoint.bucketCounts ?? []).map(Number);
  // OTLP allows a histogram with neither, which reports only its count and sum.
  const hasNoBuckets = bucketCounts.length === 0 && explicitBounds.length === 0;
  const areBucketCountsValid = bucketCounts.length === explicitBounds.length + 1 &&
    bucketCounts.every((bucketCount) => Number.isFinite(bucketCount) && bucketCount >= 0);
  if (!hasNoBuckets && !areBucketCountsValid) {
    return "the histogram needs one bucket count more than it has bounds";
  }
  const series = createSeries(
    dataPoint,
    definition,
    resourceContext,
    explicitBounds,
    pointTimes.time,
  );
  return {
    series,
    point: {
      seriesId: series.seriesId,
      timeUnixNano: pointTimes.time,
      startTimeUnixNano: pointTimes.start,
      value: null,
      histogram: { count, sum, bucketCounts },
    },
  };
}

function hasNoRecordedValue(flags: number | undefined): boolean {
  return ((flags ?? 0) & NO_RECORDED_VALUE_FLAG) !== 0;
}

function readPointTimes(
  dataPoint: { timeUnixNano?: string | number; startTimeUnixNano?: string | number },
  receivedUnixNanoseconds: bigint,
): { time: bigint; start: bigint | null } | string {
  const time = parseUnixNanoseconds(dataPoint.timeUnixNano);
  if (time === null || time === 0n) return "the time is missing";
  const windowRejection = findTimeWindowRejection(time, receivedUnixNanoseconds);
  if (windowRejection !== null) return windowRejection;
  const start = parseUnixNanoseconds(dataPoint.startTimeUnixNano);
  return { time, start: start === null || start === 0n ? null : start };
}

function readFiniteNumber(rawValue: number | string | undefined): number | null {
  if (rawValue === undefined) return null;
  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function createSeries(
  dataPoint: { attributes?: OtlpNumberDataPoint["attributes"] },
  definition: MetricDefinition,
  resourceContext: ResourceContext,
  explicitBounds: number[] | null,
  timeUnixNano: bigint,
): IncomingMetricSeries {
  const attributes = makeValueStorable(convertKeyValues(dataPoint.attributes)) as Record<
    string,
    unknown
  >;
  return {
    seriesId: hashSeriesIdentity([
      definition.metricName,
      definition.metricType,
      definition.unit,
      definition.temporality,
      definition.isMonotonic,
      resourceContext.scopeName,
      resourceContext.scopeVersion,
      explicitBounds,
      sortEntries(attributes),
      sortEntries(resourceContext.resourceAttributes),
    ]),
    ...definition,
    explicitBounds,
    serviceName: resourceContext.serviceName,
    attributes,
    resourceAttributes: resourceContext.resourceAttributes,
    lastSeenUnixNano: timeUnixNano,
  };
}

/** Exporters may send attributes in any order, which must not start a new series. */
function sortEntries(attributes: Record<string, unknown>): [string, unknown][] {
  return Object.entries(attributes).sort(([firstKey], [secondKey]) =>
    firstKey < secondKey ? -1 : firstKey > secondKey ? 1 : 0
  );
}

function hashSeriesIdentity(identityParts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(identityParts)).digest("hex");
}
