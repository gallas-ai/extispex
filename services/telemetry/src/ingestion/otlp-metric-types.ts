import type { OtlpKeyValue } from "./otlp-common-types.ts";

/** The shape of an OTLP metrics export request after decoding, as for traces and logs. */
export interface OtlpExportMetricsRequest {
  resourceMetrics?: OtlpResourceMetrics[];
}

export interface OtlpResourceMetrics {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeMetrics?: OtlpScopeMetrics[];
}

export interface OtlpScopeMetrics {
  scope?: { name?: string; version?: string };
  metrics?: OtlpMetric[];
}

/** OTLP sets exactly one of the data fields. */
export interface OtlpMetric {
  name?: string;
  unit?: string;
  gauge?: { dataPoints?: OtlpNumberDataPoint[] };
  sum?: {
    dataPoints?: OtlpNumberDataPoint[];
    aggregationTemporality?: number | string;
    isMonotonic?: boolean;
  };
  histogram?: {
    dataPoints?: OtlpHistogramDataPoint[];
    aggregationTemporality?: number | string;
  };
  exponentialHistogram?: { dataPoints?: unknown[] };
  summary?: { dataPoints?: unknown[] };
}

export interface OtlpNumberDataPoint {
  attributes?: OtlpKeyValue[];
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  asDouble?: number | string;
  asInt?: number | string;
  flags?: number;
}

export interface OtlpHistogramDataPoint {
  attributes?: OtlpKeyValue[];
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  count?: number | string;
  sum?: number | string;
  bucketCounts?: (number | string)[];
  explicitBounds?: (number | string)[];
  flags?: number;
}

export interface MetricsExportOutcome {
  rejectedDataPointCount: number;
  errorMessage: string | null;
}
