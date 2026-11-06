import type { StructuredLogger } from "@evaluation-telemetry/service-runtime";
import { createErrorResponse } from "@evaluation-telemetry/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { authenticateProject, type ProjectResolver } from "../projects/project-authentication.ts";
import {
  createJsonTraceResponse,
  decodeJsonTraceRequest,
  decodeProtobufTraceRequest,
  encodeProtobufTraceResponse,
  OtlpPayloadError,
} from "./otlp-protocol.ts";
import type { OtlpExportTraceRequest } from "./otlp-trace-types.ts";
import type { TraceIngestion } from "./trace-ingestion.ts";

const MAXIMUM_PAYLOAD_BYTES = 32 * 1024 * 1024;
const RETRY_AFTER_SECONDS = "5";

type PayloadEncoding = "protobuf" | "json";

export interface OtlpHttpRouteDependencies {
  traceIngestion: TraceIngestion;
  projectResolver: ProjectResolver;
  logger: StructuredLogger;
}

/** Registers the OTLP/HTTP trace endpoint, accepting protobuf and JSON payloads. */
export function registerOtlpHttpRoutes(
  app: OpenAPIHono,
  dependencies: OtlpHttpRouteDependencies,
): void {
  app.post("/v1/traces", async (context) => {
    const payloadEncoding = detectPayloadEncoding(context.req.header("content-type"));
    if (payloadEncoding === null) {
      return respondWithError(
        context,
        415,
        "unsupported_media_type",
        "Use application/x-protobuf or application/json.",
      );
    }
    const projectId = await authenticateProject(
      dependencies.projectResolver,
      context.req.header("authorization"),
    );
    if (projectId === null) {
      return respondWithError(
        context,
        401,
        "unauthenticated",
        "A valid API key is required in the Authorization header as a Bearer token.",
      );
    }
    let exportRequest: OtlpExportTraceRequest;
    try {
      const payload = await readPayload(context.req.raw);
      exportRequest = payloadEncoding === "protobuf"
        ? decodeProtobufTraceRequest(payload)
        : decodeJsonTraceRequest(new TextDecoder().decode(payload));
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
      const exportOutcome = await dependencies.traceIngestion.ingestTraces(
        projectId,
        exportRequest,
      );
      if (payloadEncoding === "json") {
        return context.json(createJsonTraceResponse(exportOutcome));
      }
      return context.body(
        encodeProtobufTraceResponse(exportOutcome) as Uint8Array<ArrayBuffer>,
        200,
        {
          "content-type": "application/x-protobuf",
        },
      );
    } catch (error) {
      dependencies.logger.error("Storing spans failed", { error, projectId });
      context.header("retry-after", RETRY_AFTER_SECONDS);
      return respondWithError(
        context,
        503,
        "storage_unavailable",
        "Spans could not be stored. Retry later.",
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

class PayloadTooLargeError extends Error {
  override name = "PayloadTooLargeError";
}

async function readPayload(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAXIMUM_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(`Payload exceeds ${MAXIMUM_PAYLOAD_BYTES} bytes.`);
  }
  const isGzipped = request.headers.get("content-encoding")?.toLowerCase() === "gzip";
  const bodyStream = request.body ?? new Blob([]).stream();
  const decodedStream = isGzipped
    ? bodyStream.pipeThrough(new DecompressionStream("gzip"))
    : bodyStream;
  try {
    const payload = new Uint8Array(await new Response(decodedStream).arrayBuffer());
    if (payload.byteLength > MAXIMUM_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(`Payload exceeds ${MAXIMUM_PAYLOAD_BYTES} bytes.`);
    }
    return payload;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw error;
    }
    throw new OtlpPayloadError(`Payload could not be read: ${(error as Error).message}`);
  }
}

function respondWithError(
  context: Context,
  statusCode: 400 | 401 | 413 | 415 | 503,
  errorCode: string,
  errorMessage: string,
): Response {
  return context.json(createErrorResponse(errorCode, errorMessage), statusCode);
}
