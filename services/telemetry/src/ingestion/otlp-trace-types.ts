import type { OtlpKeyValue } from "./otlp-common-types.ts";

/**
 * The shape of an OTLP trace export request after decoding. Protobuf decoding yields byte arrays
 * for IDs and decimal strings for 64-bit integers; OTLP/JSON yields hex strings and either
 * strings or numbers. Normalization accepts both.
 */
export interface OtlpExportTraceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

export interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpScopeSpans {
  spans?: OtlpSpan[];
}

export interface OtlpSpan {
  traceId?: Uint8Array | string;
  spanId?: Uint8Array | string;
  parentSpanId?: Uint8Array | string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  status?: { code?: number | string; message?: string };
}

export interface TraceExportOutcome {
  rejectedSpanCount: number;
  errorMessage: string | null;
}
