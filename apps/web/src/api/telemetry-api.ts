import type {
  ListLogsResponse,
  ListMetricAttributesResponse,
  ListMetricsResponse,
  ListTracesResponse,
  LogSeverity,
  MetricAggregation,
  QueryMetricResponse,
  RejectedTelemetry,
  TraceDetailResponse,
} from "@extispex/contracts";
import { type ApiCredentials, requestJson } from "./api-request.ts";

export interface TraceFilters {
  correlationId: string;
  sessionId: string;
}

export function listTraces(
  credentials: ApiCredentials,
  filters: TraceFilters,
): Promise<ListTracesResponse> {
  const searchParameters = new URLSearchParams();
  if (filters.correlationId) searchParameters.set("correlationId", filters.correlationId);
  if (filters.sessionId) searchParameters.set("sessionId", filters.sessionId);
  return requestJson(credentials, `/v1/traces?${searchParameters}`);
}

export function getTrace(
  credentials: ApiCredentials,
  traceId: string,
): Promise<TraceDetailResponse> {
  return requestJson(credentials, `/v1/traces/${encodeURIComponent(traceId)}`);
}

export interface LogQuery {
  from?: string;
  to?: string;
  search?: string;
  minimumSeverity?: LogSeverity;
  serviceName?: string;
  correlationId?: string;
  traceId?: string;
  attribute?: string;
  limit?: number;
  cursor?: string;
}

export function listLogs(credentials: ApiCredentials, query: LogQuery): Promise<ListLogsResponse> {
  const searchParameters = new URLSearchParams();
  for (const [parameter, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") searchParameters.set(parameter, String(value));
  }
  return requestJson(credentials, `/v1/logs?${searchParameters}`);
}

export function getRejectedTelemetry(credentials: ApiCredentials): Promise<RejectedTelemetry> {
  return requestJson(credentials, "/v1/rejected-telemetry");
}

export function listMetrics(credentials: ApiCredentials): Promise<ListMetricsResponse> {
  return requestJson(credentials, "/v1/metrics");
}

export function listMetricAttributes(
  credentials: ApiCredentials,
  metricName: string,
): Promise<ListMetricAttributesResponse> {
  const searchParameters = new URLSearchParams({ metric: metricName });
  return requestJson(credentials, `/v1/metrics/attributes?${searchParameters}`);
}

export interface MetricQuery {
  metric: string;
  aggregation: MetricAggregation;
  from: string;
  to: string;
  groupBy?: string;
  attribute?: string;
}

export function queryMetric(
  credentials: ApiCredentials,
  query: MetricQuery,
): Promise<QueryMetricResponse> {
  const searchParameters = new URLSearchParams();
  for (const [parameter, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") searchParameters.set(parameter, value);
  }
  return requestJson(credentials, `/v1/metrics/query?${searchParameters}`);
}
