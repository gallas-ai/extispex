import { createErrorResponse, isRoleAtLeast } from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import {
  IdentityUnavailableError,
  type ProjectAccess,
  type RequestAuthenticator,
  RETRY_AFTER_SECONDS,
  type StructuredLogger,
} from "@extispex/service-runtime";
import type { LogIngestion } from "./log-ingestion.ts";
import type { MetricIngestion } from "./metric-ingestion.ts";
import {
  createJsonLogsResponse,
  createJsonMetricsResponse,
  createJsonTraceResponse,
  decodeJsonLogsRequest,
  decodeJsonMetricsRequest,
  decodeJsonTraceRequest,
  decodeProtobufLogsRequest,
  decodeProtobufMetricsRequest,
  decodeProtobufTraceRequest,
  encodeProtobufLogsResponse,
  encodeProtobufMetricsResponse,
  encodeProtobufTraceResponse,
  MAXIMUM_OTLP_PAYLOAD_BYTES,
  OtlpPayloadError,
} from "./otlp-protocol.ts";
import type { TraceIngestion } from "./trace-ingestion.ts";

type PayloadEncoding = "protobuf" | "json";

/** Content encodings OTLP/HTTP accepts besides an uncompressed body. */
const SUPPORTED_CONTENT_ENCODINGS = ["gzip", "deflate"] as const;
type ContentEncoding = typeof SUPPORTED_CONTENT_ENCODINGS[number] | "identity";

export interface OtlpHttpRouteDependencies {
  traceIngestion: TraceIngestion;
  logIngestion: LogIngestion;
  metricIngestion: MetricIngestion;
  requestAuthenticator: RequestAuthenticator;
  logger: StructuredLogger;
}

interface OtlpHttpSignal<ExportRequest, ExportOutcome> {
  path: string;
  /** How error messages call the signal's records, for example "Spans". */
  recordsName: string;
  decodeProtobufRequest(payload: Uint8Array): ExportRequest;
  decodeJsonRequest(payloadText: string): ExportRequest;
  encodeProtobufResponse(outcome: ExportOutcome): Uint8Array;
  createJsonResponse(outcome: ExportOutcome): Record<string, unknown>;
  ingest(projectId: string, request: ExportRequest): Promise<ExportOutcome>;
}

/** Registers the OTLP/HTTP endpoints, accepting protobuf and JSON payloads. */
export function registerOtlpHttpRoutes<Environment extends Env>(
  app: OpenAPIHono<Environment>,
  dependencies: OtlpHttpRouteDependencies,
): void {
  registerOtlpSignalRoute(app, dependencies, {
    path: "/v1/traces",
    recordsName: "Spans",
    decodeProtobufRequest: decodeProtobufTraceRequest,
    decodeJsonRequest: decodeJsonTraceRequest,
    encodeProtobufResponse: encodeProtobufTraceResponse,
    createJsonResponse: createJsonTraceResponse,
    ingest: dependencies.traceIngestion.ingestTraces,
  });
  registerOtlpSignalRoute(app, dependencies, {
    path: "/v1/logs",
    recordsName: "Log records",
    decodeProtobufRequest: decodeProtobufLogsRequest,
    decodeJsonRequest: decodeJsonLogsRequest,
    encodeProtobufResponse: encodeProtobufLogsResponse,
    createJsonResponse: createJsonLogsResponse,
    ingest: dependencies.logIngestion.ingestLogs,
  });
  registerOtlpSignalRoute(app, dependencies, {
    path: "/v1/metrics",
    recordsName: "Metric data points",
    decodeProtobufRequest: decodeProtobufMetricsRequest,
    decodeJsonRequest: decodeJsonMetricsRequest,
    encodeProtobufResponse: encodeProtobufMetricsResponse,
    createJsonResponse: createJsonMetricsResponse,
    ingest: dependencies.metricIngestion.ingestMetrics,
  });
}

function registerOtlpSignalRoute<Environment extends Env, ExportRequest, ExportOutcome>(
  app: OpenAPIHono<Environment>,
  dependencies: OtlpHttpRouteDependencies,
  signal: OtlpHttpSignal<ExportRequest, ExportOutcome>,
): void {
  app.post(signal.path, async (context) => {
    const payloadEncoding = detectPayloadEncoding(context.req.header("content-type"));
    if (payloadEncoding === null) {
      return respondWithError(
        context,
        415,
        "unsupported_media_type",
        "Use application/x-protobuf or application/json.",
      );
    }
    const contentEncoding = detectContentEncoding(context.req.header("content-encoding"));
    if (contentEncoding === null) {
      context.header("accept-encoding", SUPPORTED_CONTENT_ENCODINGS.join(", "));
      return respondWithError(
        context,
        415,
        "unsupported_content_encoding",
        `Send the body uncompressed or with Content-Encoding ${
          SUPPORTED_CONTENT_ENCODINGS.join(" or ")
        }.`,
      );
    }
    let projectAccess: ProjectAccess | null;
    try {
      projectAccess = await dependencies.requestAuthenticator.authenticateRequest(
        context.req.header("authorization"),
      );
    } catch (error) {
      if (!(error instanceof IdentityUnavailableError)) throw error;
      dependencies.logger.warn("Credentials could not be checked", { error });
      context.header("retry-after", RETRY_AFTER_SECONDS);
      return respondWithError(
        context,
        503,
        "identity_unavailable",
        "The credentials could not be checked. Retry later.",
      );
    }
    if (projectAccess === null) {
      return respondWithError(
        context,
        401,
        "unauthenticated",
        "A valid API key is required in the Authorization header as a Bearer token.",
      );
    }
    if (!isRoleAtLeast(projectAccess.role, "editor")) {
      return respondWithError(
        context,
        403,
        "forbidden",
        "Sending telemetry takes the Role editor in the Project, as an API key has.",
      );
    }
    const { projectId } = projectAccess;
    let exportRequest: ExportRequest;
    try {
      const payload = await readPayload(context.req.raw, contentEncoding);
      exportRequest = payloadEncoding === "protobuf"
        ? signal.decodeProtobufRequest(payload)
        : signal.decodeJsonRequest(new TextDecoder().decode(payload));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return respondWithError(context, 413, "payload_too_large", error.message);
      }
      if (error instanceof OtlpPayloadError) {
        return respondWithError(context, 400, "invalid_payload", error.message);
      }
      throw error;
    }
    try {
      const exportOutcome = await signal.ingest(projectId, exportRequest);
      if (payloadEncoding === "json") {
        return context.json(signal.createJsonResponse(exportOutcome));
      }
      return context.body(
        signal.encodeProtobufResponse(exportOutcome) as Uint8Array<ArrayBuffer>,
        200,
        {
          "content-type": "application/x-protobuf",
        },
      );
    } catch (error) {
      dependencies.logger.error(`Storing ${signal.recordsName.toLowerCase()} failed`, {
        error,
        projectId,
      });
      context.header("retry-after", RETRY_AFTER_SECONDS);
      return respondWithError(
        context,
        503,
        "storage_unavailable",
        `${signal.recordsName} could not be stored. Retry later.`,
      );
    }
  });
}

function detectPayloadEncoding(contentType: string | undefined): PayloadEncoding | null {
  const mediaType = contentType?.split(";")[0].trim().toLowerCase();
  if (mediaType === "application/x-protobuf" || mediaType === "application/protobuf") {
    return "protobuf";
  }
  if (mediaType === "application/json") {
    return "json";
  }
  return null;
}

function detectContentEncoding(contentEncoding: string | undefined): ContentEncoding | null {
  const normalizedEncoding = contentEncoding?.trim().toLowerCase() || "identity";
  if (normalizedEncoding === "identity") {
    return "identity";
  }
  return SUPPORTED_CONTENT_ENCODINGS.find((encoding) => encoding === normalizedEncoding) ?? null;
}

class PayloadTooLargeError extends Error {
  override name = "PayloadTooLargeError";
}

async function readPayload(
  request: Request,
  contentEncoding: ContentEncoding,
): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAXIMUM_OTLP_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(`Payload exceeds ${MAXIMUM_OTLP_PAYLOAD_BYTES} bytes.`);
  }
  const bodyStream = request.body ?? new Blob([]).stream();
  const decodedStream = contentEncoding === "identity"
    ? bodyStream
    : bodyStream.pipeThrough(new DecompressionStream(contentEncoding));
  try {
    return await readWithinLimit(decodedStream);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw error;
    }
    throw new OtlpPayloadError(`Payload could not be read: ${(error as Error).message}`);
  }
}

/**
 * Collects the decoded payload and stops at the limit, so that a small compressed body cannot
 * decompress into unbounded memory.
 */
async function readWithinLimit(decodedStream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const payloadChunks: Uint8Array[] = [];
  let payloadBytes = 0;
  for await (const payloadChunk of decodedStream) {
    payloadBytes += payloadChunk.byteLength;
    if (payloadBytes > MAXIMUM_OTLP_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(`Payload exceeds ${MAXIMUM_OTLP_PAYLOAD_BYTES} bytes.`);
    }
    payloadChunks.push(payloadChunk);
  }
  const payload = new Uint8Array(payloadBytes);
  let writeOffset = 0;
  for (const payloadChunk of payloadChunks) {
    payload.set(payloadChunk, writeOffset);
    writeOffset += payloadChunk.byteLength;
  }
  return payload;
}

function respondWithError(
  context: Context,
  statusCode: 400 | 401 | 403 | 413 | 415 | 503,
  errorCode: string,
  errorMessage: string,
): Response {
  return context.json(createErrorResponse(errorCode, errorMessage), statusCode);
}
