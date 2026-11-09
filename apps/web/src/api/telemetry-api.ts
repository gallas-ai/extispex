import type {
  ListLogsResponse,
  ListTracesResponse,
  LogSeverity,
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
