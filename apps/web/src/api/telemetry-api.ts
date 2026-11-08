import type { ListTracesResponse, TraceDetailResponse } from "@extispex/contracts";
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
