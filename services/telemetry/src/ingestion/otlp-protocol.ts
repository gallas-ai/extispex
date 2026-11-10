import protobuf from "protobufjs";
import otlpDescriptor from "./generated/otlp-descriptor.json" with { type: "json" };
import type { LogsExportOutcome, OtlpExportLogsRequest } from "./otlp-log-types.ts";
import type { MetricsExportOutcome, OtlpExportMetricsRequest } from "./otlp-metric-types.ts";
import type { OtlpExportTraceRequest, TraceExportOutcome } from "./otlp-trace-types.ts";

/**
 * The largest decoded OTLP export request accepted over HTTP and gRPC. Compressed bodies are
 * measured after decompression.
 */
export const MAXIMUM_OTLP_PAYLOAD_BYTES = 32 * 1024 * 1024;

export class OtlpPayloadError extends Error {
  override name = "OtlpPayloadError";
}

const otlpRoot = protobuf.Root.fromJSON(otlpDescriptor as protobuf.INamespace);
const exportTraceRequestType = otlpRoot.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
const exportTraceResponseType = otlpRoot.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse",
);
const exportLogsRequestType = otlpRoot.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
);
const exportLogsResponseType = otlpRoot.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse",
);

const exportMetricsRequestType = otlpRoot.lookupType(
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
);
const exportMetricsResponseType = otlpRoot.lookupType(
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse",
);

function decodeProtobufMessage<DecodedRequest>(
  messageType: protobuf.Type,
  payload: Uint8Array,
): DecodedRequest {
  try {
    const decodedMessage = messageType.decode(payload);
    return messageType.toObject(decodedMessage, {
      longs: String,
      enums: Number,
      arrays: true,
    }) as DecodedRequest;
  } catch (error) {
    throw new OtlpPayloadError(`Invalid OTLP protobuf payload: ${(error as Error).message}`);
  }
}

export function decodeProtobufTraceRequest(payload: Uint8Array): OtlpExportTraceRequest {
  return decodeProtobufMessage(exportTraceRequestType, payload);
}

export function decodeProtobufLogsRequest(payload: Uint8Array): OtlpExportLogsRequest {
  return decodeProtobufMessage(exportLogsRequestType, payload);
}

export function decodeProtobufMetricsRequest(payload: Uint8Array): OtlpExportMetricsRequest {
  return decodeProtobufMessage(exportMetricsRequestType, payload);
}

export function decodeJsonTraceRequest(payloadText: string): OtlpExportTraceRequest {
  return parseJsonRequest(payloadText) as OtlpExportTraceRequest;
}

export function decodeJsonLogsRequest(payloadText: string): OtlpExportLogsRequest {
  return parseJsonRequest(payloadText) as OtlpExportLogsRequest;
}

export function decodeJsonMetricsRequest(payloadText: string): OtlpExportMetricsRequest {
  return parseJsonRequest(payloadText) as OtlpExportMetricsRequest;
}

function parseJsonRequest(payloadText: string): unknown {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadText);
  } catch (error) {
    throw new OtlpPayloadError(`Invalid OTLP JSON payload: ${(error as Error).message}`);
  }
  if (typeof parsedPayload !== "object" || parsedPayload === null || Array.isArray(parsedPayload)) {
    throw new OtlpPayloadError("Invalid OTLP JSON payload: expected an object.");
  }
  return parsedPayload;
}

/** OTLP requires `partial_success` to stay unset when every span was accepted. */
function createTraceResponsePayload(outcome: TraceExportOutcome): Record<string, unknown> {
  if (outcome.rejectedSpanCount === 0) {
    return {};
  }
  return {
    partialSuccess: {
      rejectedSpans: outcome.rejectedSpanCount,
      errorMessage: outcome.errorMessage ?? "",
    },
  };
}

export function encodeProtobufTraceResponse(outcome: TraceExportOutcome): Uint8Array {
  const responseMessage = exportTraceResponseType.fromObject(createTraceResponsePayload(outcome));
  return exportTraceResponseType.encode(responseMessage).finish();
}

export function createJsonTraceResponse(outcome: TraceExportOutcome): Record<string, unknown> {
  return createTraceResponsePayload(outcome);
}

function createLogsResponsePayload(outcome: LogsExportOutcome): Record<string, unknown> {
  if (outcome.rejectedLogRecordCount === 0) {
    return {};
  }
  return {
    partialSuccess: {
      rejectedLogRecords: outcome.rejectedLogRecordCount,
      errorMessage: outcome.errorMessage ?? "",
    },
  };
}

export function encodeProtobufLogsResponse(outcome: LogsExportOutcome): Uint8Array {
  const responseMessage = exportLogsResponseType.fromObject(createLogsResponsePayload(outcome));
  return exportLogsResponseType.encode(responseMessage).finish();
}

export function createJsonLogsResponse(outcome: LogsExportOutcome): Record<string, unknown> {
  return createLogsResponsePayload(outcome);
}

function createMetricsResponsePayload(outcome: MetricsExportOutcome): Record<string, unknown> {
  if (outcome.rejectedDataPointCount === 0) {
    return {};
  }
  return {
    partialSuccess: {
      rejectedDataPoints: outcome.rejectedDataPointCount,
      errorMessage: outcome.errorMessage ?? "",
    },
  };
}

export function encodeProtobufMetricsResponse(outcome: MetricsExportOutcome): Uint8Array {
  const responseMessage = exportMetricsResponseType.fromObject(
    createMetricsResponsePayload(outcome),
  );
  return exportMetricsResponseType.encode(responseMessage).finish();
}

export function createJsonMetricsResponse(outcome: MetricsExportOutcome): Record<string, unknown> {
  return createMetricsResponsePayload(outcome);
}
