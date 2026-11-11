import { CORRELATION_ID_ATTRIBUTE } from "@extispex/telemetry-ids/attributes";
import { createHash } from "node:crypto";
import type { OtlpExportLogsRequest, OtlpLogRecord } from "./otlp-log-types.ts";
import {
  convertAnyValue,
  convertIdToHex,
  convertKeyValues,
  parseUnixNanoseconds,
  SPAN_ID_HEX_LENGTH,
  TRACE_ID_HEX_LENGTH,
} from "./otlp-values.ts";
import { findTimeWindowRejection } from "./record-time-window.ts";
import { makeTextStorable, makeValueStorable } from "./stored-text.ts";

/** A log record converted from OTLP into the platform's own representation. */
export interface IncomingLogRecord {
  /** Identifies the record's content, so that a retried batch stores nothing twice. */
  logId: string;
  timeUnixNano: bigint;
  severityNumber: number;
  severityText: string | null;
  bodyText: string;
  /** The body when it is a map or a list; `bodyText` then holds it as JSON. */
  structuredBody: unknown;
  traceId: string | null;
  spanId: string | null;
  correlationId: string | null;
  serviceName: string | null;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
}

export interface LogNormalizationResult {
  logRecords: IncomingLogRecord[];
  /** One entry per rejected record: why it was rejected. */
  rejectionReasons: string[];
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

const SERVICE_NAME_RESOURCE_ATTRIBUTE = "service.name";
const HIGHEST_SEVERITY_NUMBER = 24;

const SEVERITY_NUMBERS_BY_NAME_PREFIX: Record<string, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

export function normalizeLogsRequest(
  request: OtlpExportLogsRequest,
  receivedAt: Date,
): LogNormalizationResult {
  const result: LogNormalizationResult = { logRecords: [], rejectionReasons: [] };
  for (const resourceLogs of request.resourceLogs ?? []) {
    const resourceAttributes = makeValueStorable(
      convertKeyValues(resourceLogs.resource?.attributes),
    ) as Record<string, unknown>;
    const serviceNameAttribute = resourceAttributes[SERVICE_NAME_RESOURCE_ATTRIBUTE];
    const serviceName = typeof serviceNameAttribute === "string" ? serviceNameAttribute : null;
    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      for (const otlpLogRecord of scopeLogs.logRecords ?? []) {
        const outcome = normalizeLogRecord(
          otlpLogRecord,
          serviceName,
          resourceAttributes,
          receivedAt,
        );
        if (typeof outcome === "string") {
          result.rejectionReasons.push(outcome);
        } else {
          result.logRecords.push(outcome);
        }
      }
    }
  }
  return result;
}

function normalizeLogRecord(
  otlpLogRecord: OtlpLogRecord,
  serviceName: string | null,
  resourceAttributes: Record<string, unknown>,
  receivedAt: Date,
): IncomingLogRecord | string {
  const receivedUnixNanoseconds = BigInt(receivedAt.getTime()) * NANOSECONDS_PER_MILLISECOND;
  const timeUnixNano = chooseLogTime(otlpLogRecord) ?? receivedUnixNanoseconds;
  const windowRejection = findTimeWindowRejection(timeUnixNano, receivedUnixNanoseconds);
  if (windowRejection !== null) return windowRejection;

  // OTLP says a malformed ID means that the record is not associated with a trace or span.
  const traceId = convertIdToHex(otlpLogRecord.traceId, TRACE_ID_HEX_LENGTH);
  const spanId = traceId === null ? null : convertIdToHex(otlpLogRecord.spanId, SPAN_ID_HEX_LENGTH);
  const attributes = makeValueStorable(convertKeyValues(otlpLogRecord.attributes)) as Record<
    string,
    unknown
  >;
  const correlationId = readNonEmptyString(attributes[CORRELATION_ID_ATTRIBUTE]);
  if (traceId !== null && correlationId === null) {
    return `missing required attribute ${CORRELATION_ID_ATTRIBUTE}`;
  }
  const severityNumber = convertSeverityNumber(otlpLogRecord.severityNumber);
  const severityText = otlpLogRecord.severityText
    ? makeTextStorable(otlpLogRecord.severityText)
    : null;
  const { bodyText, structuredBody } = convertBody(otlpLogRecord);
  return {
    logId: hashLogRecordContent([
      otlpLogRecord.timeUnixNano,
      otlpLogRecord.observedTimeUnixNano,
      severityNumber,
      severityText,
      bodyText,
      traceId,
      spanId,
      attributes,
      resourceAttributes,
    ]),
    timeUnixNano,
    severityNumber,
    severityText,
    bodyText,
    structuredBody,
    traceId,
    spanId,
    correlationId,
    serviceName,
    attributes,
    resourceAttributes,
  };
}

/** OTLP's advice for one timestamp: the event's time, or else when it was observed. */
function chooseLogTime(otlpLogRecord: OtlpLogRecord): bigint | null {
  for (const candidate of [otlpLogRecord.timeUnixNano, otlpLogRecord.observedTimeUnixNano]) {
    const parsedTime = parseUnixNanoseconds(candidate);
    if (parsedTime !== null && parsedTime > 0n) return parsedTime;
  }
  return null;
}

/** OTLP/JSON should send a number, but some senders use names such as `SEVERITY_NUMBER_WARN2`. */
function convertSeverityNumber(rawValue: number | string | undefined): number {
  if (typeof rawValue === "number") {
    return Number.isInteger(rawValue) && rawValue >= 0 && rawValue <= HIGHEST_SEVERITY_NUMBER
      ? rawValue
      : 0;
  }
  const nameMatch = rawValue?.match(
    /^SEVERITY_NUMBER_(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)([234]?)$/,
  );
  if (!nameMatch) return 0;
  return SEVERITY_NUMBERS_BY_NAME_PREFIX[nameMatch[1]] + Number(nameMatch[2] || 1) - 1;
}

function convertBody(
  otlpLogRecord: OtlpLogRecord,
): { bodyText: string; structuredBody: unknown } {
  const bodyValue = makeValueStorable(convertAnyValue(otlpLogRecord.body));
  if (bodyValue === null) return { bodyText: "", structuredBody: null };
  if (typeof bodyValue === "object") {
    return { bodyText: JSON.stringify(bodyValue), structuredBody: bodyValue };
  }
  return { bodyText: String(bodyValue), structuredBody: null };
}

function hashLogRecordContent(contentParts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(contentParts)).digest("hex");
}

function readNonEmptyString(attributeValue: unknown): string | null {
  return typeof attributeValue === "string" && attributeValue.trim() !== "" ? attributeValue : null;
}
