import type { ErrorResponse, ListTracesResponse, TraceDetailResponse } from "@extispex/contracts";

export class TelemetryApiError extends Error {
  override name = "TelemetryApiError";
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

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

async function requestJson<ResponseBody>(apiKey: string, path: string): Promise<ResponseBody> {
  const response = await fetch(path, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as ErrorResponse | null;
    throw new TelemetryApiError(
      errorBody?.error.message ?? `The request failed with status ${response.status}.`,
      response.status,
    );
  }
  return await response.json() as ResponseBody;
}
