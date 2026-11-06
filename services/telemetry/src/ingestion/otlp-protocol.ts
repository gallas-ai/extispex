import protobuf from "protobufjs";
import otlpTraceDescriptor from "./generated/otlp-trace-descriptor.json" with { type: "json" };
import type { OtlpExportTraceRequest, TraceExportOutcome } from "./otlp-trace-types.ts";

export class OtlpPayloadError extends Error {
  override name = "OtlpPayloadError";
}

const otlpRoot = protobuf.Root.fromJSON(otlpTraceDescriptor as protobuf.INamespace);
const exportTraceRequestType = otlpRoot.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
const exportTraceResponseType = otlpRoot.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse",
);

export function decodeProtobufTraceRequest(payload: Uint8Array): OtlpExportTraceRequest {
  try {
    const decodedMessage = exportTraceRequestType.decode(payload);
    return exportTraceRequestType.toObject(decodedMessage, {
      longs: String,
      enums: Number,
      arrays: true,
    }) as OtlpExportTraceRequest;
  } catch (error) {
    throw new OtlpPayloadError(`Invalid OTLP protobuf payload: ${(error as Error).message}`);
  }
}

export function decodeJsonTraceRequest(payloadText: string): OtlpExportTraceRequest {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadText);
  } catch (error) {
    throw new OtlpPayloadError(`Invalid OTLP JSON payload: ${(error as Error).message}`);
  }
  if (typeof parsedPayload !== "object" || parsedPayload === null || Array.isArray(parsedPayload)) {
    throw new OtlpPayloadError("Invalid OTLP JSON payload: expected an object.");
  }
  return parsedPayload as OtlpExportTraceRequest;
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
