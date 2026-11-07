import * as grpc from "@grpc/grpc-js";
import {
  authenticateProject,
  type ProjectResolver,
  type StructuredLogger,
} from "@extispex/service-runtime";
import {
  decodeProtobufTraceRequest,
  encodeProtobufTraceResponse,
  MAXIMUM_OTLP_PAYLOAD_BYTES,
  OtlpPayloadError,
} from "./otlp-protocol.ts";
import type { TraceExportOutcome } from "./otlp-trace-types.ts";
import type { TraceIngestion } from "./trace-ingestion.ts";

export interface OtlpGrpcServerDependencies {
  traceIngestion: TraceIngestion;
  projectResolver: ProjectResolver;
  logger: StructuredLogger;
}

export interface GrpcTlsFiles {
  certificateChainFile: string;
  privateKeyFile: string;
}

type RawPayload = Buffer;

/** Messages pass through as raw bytes so that the handler can answer a bad payload properly. */
const traceServiceDefinition: grpc.ServiceDefinition<grpc.UntypedServiceImplementation> = {
  export: {
    path: "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
    requestStream: false,
    responseStream: false,
    requestSerialize: (payload: RawPayload) => payload,
    requestDeserialize: (payload: RawPayload) => payload,
    responseSerialize: (outcome: TraceExportOutcome) =>
      Buffer.from(encodeProtobufTraceResponse(outcome)),
    responseDeserialize: (payload: RawPayload) => payload,
  },
};

export function createOtlpGrpcServer(dependencies: OtlpGrpcServerDependencies): grpc.Server {
  // grpc-js applies this limit after decompression, so it also bounds gzip and deflate messages.
  const grpcServer = new grpc.Server({
    "grpc.max_receive_message_length": MAXIMUM_OTLP_PAYLOAD_BYTES,
  });
  grpcServer.addService(traceServiceDefinition, {
    export: async (
      call: grpc.ServerUnaryCall<RawPayload, TraceExportOutcome>,
      respond: grpc.sendUnaryData<TraceExportOutcome>,
    ) => {
      const authorizationHeader = call.metadata.get("authorization")[0]?.toString();
      const projectId = await authenticateProject(
        dependencies.projectResolver,
        authorizationHeader,
      );
      if (projectId === null) {
        respond({
          code: grpc.status.UNAUTHENTICATED,
          details: "A valid API key is required in the authorization metadata as a Bearer token.",
        });
        return;
      }
      try {
        const exportRequest = decodeProtobufTraceRequest(call.request);
        respond(null, await dependencies.traceIngestion.ingestTraces(projectId, exportRequest));
      } catch (error) {
        if (error instanceof OtlpPayloadError) {
          respond({ code: grpc.status.INVALID_ARGUMENT, details: error.message });
          return;
        }
        dependencies.logger.error("Storing spans failed", { error, projectId });
        respond({
          code: grpc.status.UNAVAILABLE,
          details: "Spans could not be stored. Retry later.",
        });
      }
    },
  });
  return grpcServer;
}

/** Binds the server to all interfaces and resolves with the bound port. */
export async function bindOtlpGrpcServer(
  grpcServer: grpc.Server,
  port: number,
  tlsFiles: GrpcTlsFiles | null,
): Promise<number> {
  const serverCredentials = tlsFiles === null
    ? grpc.ServerCredentials.createInsecure()
    : grpc.ServerCredentials.createSsl(null, [{
      cert_chain: Buffer.from(await Deno.readFile(tlsFiles.certificateChainFile)),
      private_key: Buffer.from(await Deno.readFile(tlsFiles.privateKeyFile)),
    }]);
  return await new Promise((resolveBoundPort, rejectBinding) => {
    grpcServer.bindAsync(`0.0.0.0:${port}`, serverCredentials, (bindingError, boundPort) => {
      if (bindingError) {
        rejectBinding(bindingError);
      } else {
        resolveBoundPort(boundPort);
      }
    });
  });
}

export function shutdownOtlpGrpcServer(grpcServer: grpc.Server): Promise<void> {
  return new Promise((resolveShutdown) => grpcServer.tryShutdown(() => resolveShutdown()));
}
