import type { SpanKind, SpanStatusCode } from "@extispex/contracts";
import type {
  OtlpAnyValue,
  OtlpExportTraceRequest,
  OtlpKeyValue,
  OtlpSpan,
} from "./otlp-trace-types.ts";

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

const TRACE_ID_HEX_LENGTH = 32;
const SPAN_ID_HEX_LENGTH = 16;
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

/** Returns lowercase hex, or null for a missing, malformed or all-zero ID. */
function convertIdToHex(
  idValue: Uint8Array | string | undefined,
  expectedHexLength: number,
): string | null {
  if (idValue === undefined) {
    return null;
  }
  const hexId = typeof idValue === "string"
    ? idValue.toLowerCase()
    : Array.from(idValue, (byteValue) => byteValue.toString(16).padStart(2, "0")).join("");
  const isWellFormed = hexId.length === expectedHexLength && /^[0-9a-f]+$/.test(hexId);
  const isAllZeros = /^0+$/.test(hexId);
  return isWellFormed && !isAllZeros ? hexId : null;
}

function parseUnixNanoseconds(timeValue: string | number | undefined): bigint | null {
  if (timeValue === undefined) {
    return null;
  }
  const timeText = String(timeValue);
  return /^\d+$/.test(timeText) ? BigInt(timeText) : null;
}

/** OTLP/JSON should send enums as numbers, but some senders use names such as `SPAN_KIND_SERVER`. */
function convertEnumValue<EnumValue extends string>(
  rawValue: number | string | undefined,
  valuesByNumber: Record<number, EnumValue>,
  namePrefix: string,
  defaultValue: EnumValue,
): EnumValue {
  if (typeof rawValue === "number") {
    return valuesByNumber[rawValue] ?? defaultValue;
  }
  if (typeof rawValue === "string") {
    const valueName = rawValue.replace(namePrefix, "").toLowerCase();
    const knownValue = Object.values(valuesByNumber).find((enumValue) => enumValue === valueName);
    return knownValue ?? defaultValue;
  }
  return defaultValue;
}

function convertKeyValues(keyValues: OtlpKeyValue[] | undefined): Record<string, unknown> {
  const convertedAttributes: Record<string, unknown> = {};
  for (const keyValue of keyValues ?? []) {
    if (keyValue.key) {
      convertedAttributes[keyValue.key] = convertAnyValue(keyValue.value);
    }
  }
  return convertedAttributes;
}

function convertAnyValue(anyValue: OtlpAnyValue | undefined): unknown {
  if (anyValue === undefined) {
    return null;
  }
  if (anyValue.stringValue !== undefined) return anyValue.stringValue;
  if (anyValue.boolValue !== undefined) return anyValue.boolValue;
  if (anyValue.doubleValue !== undefined) return anyValue.doubleValue;
  if (anyValue.intValue !== undefined) {
    const integerValue = Number(anyValue.intValue);
    return Number.isSafeInteger(integerValue) ? integerValue : String(anyValue.intValue);
  }
  if (anyValue.arrayValue !== undefined) {
    return (anyValue.arrayValue.values ?? []).map(convertAnyValue);
  }
  if (anyValue.kvlistValue !== undefined) {
    return convertKeyValues(anyValue.kvlistValue.values);
  }
  if (anyValue.bytesValue !== undefined) {
    return typeof anyValue.bytesValue === "string"
      ? anyValue.bytesValue
      : btoa(String.fromCharCode(...anyValue.bytesValue));
  }
  return null;
}
