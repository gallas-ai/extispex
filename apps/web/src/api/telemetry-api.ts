import type { ListTracesResponse, TraceDetailResponse } from "@extispex/contracts";
import { requestJson } from "./api-request.ts";

export interface TraceFilters {
  correlationId: string;
  sessionId: string;
}

export function listTraces(apiKey: string, filters: TraceFilters): Promise<ListTracesResponse> {
  const searchParameters = new URLSearchParams();
  if (filters.correlationId) searchParameters.set("correlationId", filters.correlationId);
  if (filters.sessionId) searchParameters.set("sessionId", filters.sessionId);
  return requestJson(apiKey, `/v1/traces?${searchParameters}`);
}

export function getTrace(apiKey: string, traceId: string): Promise<TraceDetailResponse> {
  return requestJson(apiKey, `/v1/traces/${encodeURIComponent(traceId)}`);
}
