import type { SpanKind, SpanStatusCode } from "@extispex/contracts";
import type { OtlpExportTraceRequest, OtlpSpan } from "./otlp-trace-types.ts";
import {
  convertEnumValue,
  convertIdToHex,
  convertKeyValues,
  parseUnixNanoseconds,
  SPAN_ID_HEX_LENGTH,
  TRACE_ID_HEX_LENGTH,
} from "./otlp-values.ts";

/** A span converted from OTLP into the platform's own representation. */
export interface IncomingSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  statusCode: SpanStatusCode;
  statusMessage: string | null;
  serviceName: string | null;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
}

export interface SpanRejection {
  spanName: string;
  reason: string;
}

export interface SpanNormalizationResult {
  spans: IncomingSpan[];
  rejections: SpanRejection[];
}

const SERVICE_NAME_RESOURCE_ATTRIBUTE = "service.name";

const SPAN_KINDS_BY_NUMBER: Record<number, SpanKind> = {
  0: "unspecified",
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

const STATUS_CODES_BY_NUMBER: Record<number, SpanStatusCode> = { 0: "unset", 1: "ok", 2: "error" };

export function normalizeTraceRequest(request: OtlpExportTraceRequest): SpanNormalizationResult {
  const result: SpanNormalizationResult = { spans: [], rejections: [] };
  for (const resourceSpans of request.resourceSpans ?? []) {
    const resourceAttributes = convertKeyValues(resourceSpans.resource?.attributes);
    const serviceNameAttribute = resourceAttributes[SERVICE_NAME_RESOURCE_ATTRIBUTE];
    const serviceName = typeof serviceNameAttribute === "string" ? serviceNameAttribute : null;
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const otlpSpan of scopeSpans.spans ?? []) {
        const normalizationOutcome = normalizeSpan(otlpSpan, serviceName, resourceAttributes);
        if ("reason" in normalizationOutcome) {
          result.rejections.push(normalizationOutcome);
        } else {
          result.spans.push(normalizationOutcome);
        }
      }
    }
  }
  return result;
}

function normalizeSpan(
  otlpSpan: OtlpSpan,
  serviceName: string | null,
  resourceAttributes: Record<string, unknown>,
): IncomingSpan | SpanRejection {
  const spanName = otlpSpan.name ?? "";
  const traceId = convertIdToHex(otlpSpan.traceId, TRACE_ID_HEX_LENGTH);
  if (traceId === null) {
    return { spanName, reason: "invalid trace ID" };
  }
  const spanId = convertIdToHex(otlpSpan.spanId, SPAN_ID_HEX_LENGTH);
  if (spanId === null) {
    return { spanName, reason: "invalid span ID" };
  }
  const startTimeUnixNano = parseUnixNanoseconds(otlpSpan.startTimeUnixNano);
  const endTimeUnixNano = parseUnixNanoseconds(otlpSpan.endTimeUnixNano);
  if (startTimeUnixNano === null || endTimeUnixNano === null) {
    return { spanName, reason: "invalid start or end time" };
  }
  return {
    traceId,
    spanId,
    parentSpanId: convertIdToHex(otlpSpan.parentSpanId, SPAN_ID_HEX_LENGTH),
    name: spanName,
    kind: convertEnumValue(otlpSpan.kind, SPAN_KINDS_BY_NUMBER, "SPAN_KIND_", "unspecified"),
    startTimeUnixNano,
    endTimeUnixNano,
    statusCode: convertEnumValue(
      otlpSpan.status?.code,
      STATUS_CODES_BY_NUMBER,
      "STATUS_CODE_",
      "unset",
    ),
    statusMessage: otlpSpan.status?.message || null,
    serviceName,
    attributes: convertKeyValues(otlpSpan.attributes),
    resourceAttributes,
  };
}
