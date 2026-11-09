import * as grpc from "@grpc/grpc-js";
import { isRoleAtLeast } from "@extispex/contracts";
import {
  IdentityUnavailableError,
  type ProjectAccess,
  type RequestAuthenticator,
  type StructuredLogger,
} from "@extispex/service-runtime";
import type { LogIngestion } from "./log-ingestion.ts";
import {
  decodeProtobufLogsRequest,
  decodeProtobufTraceRequest,
  encodeProtobufLogsResponse,
  encodeProtobufTraceResponse,
  MAXIMUM_OTLP_PAYLOAD_BYTES,
  OtlpPayloadError,
} from "./otlp-protocol.ts";
import type { TraceIngestion } from "./trace-ingestion.ts";

export interface OtlpGrpcServerDependencies {
  traceIngestion: TraceIngestion;
  logIngestion: LogIngestion;
  requestAuthenticator: RequestAuthenticator;
  logger: StructuredLogger;
}

export interface GrpcTlsFiles {
  certificateChainFile: string;
  privateKeyFile: string;
}

type RawPayload = Buffer;

interface OtlpGrpcSignal<ExportRequest, ExportOutcome> {
  /** The fully qualified method, for example `/…TraceService/Export`. */
  methodPath: string;
  /** How messages call the signal's records, for example "Spans". */
  recordsName: string;
  decodeRequest(payload: Uint8Array): ExportRequest;
  encodeResponse(outcome: ExportOutcome): Uint8Array;
  ingest(projectId: string, request: ExportRequest): Promise<ExportOutcome>;
}

export function createOtlpGrpcServer(dependencies: OtlpGrpcServerDependencies): grpc.Server {
  // grpc-js applies this limit after decompression, so it also bounds gzip and deflate messages.
  const grpcServer = new grpc.Server({
    "grpc.max_receive_message_length": MAXIMUM_OTLP_PAYLOAD_BYTES,
  });
  addOtlpSignalService(grpcServer, dependencies, {
    methodPath: "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
    recordsName: "Spans",
    decodeRequest: decodeProtobufTraceRequest,
    encodeResponse: encodeProtobufTraceResponse,
    ingest: dependencies.traceIngestion.ingestTraces,
  });
  addOtlpSignalService(grpcServer, dependencies, {
    methodPath: "/opentelemetry.proto.collector.logs.v1.LogsService/Export",
    recordsName: "Log records",
    decodeRequest: decodeProtobufLogsRequest,
    encodeResponse: encodeProtobufLogsResponse,
    ingest: dependencies.logIngestion.ingestLogs,
  });
  return grpcServer;
}

function addOtlpSignalService<ExportRequest, ExportOutcome>(
  grpcServer: grpc.Server,
  dependencies: OtlpGrpcServerDependencies,
  signal: OtlpGrpcSignal<ExportRequest, ExportOutcome>,
): void {
  /** Messages pass through as raw bytes so that the handler can answer a bad payload properly. */
  const serviceDefinition: grpc.ServiceDefinition<grpc.UntypedServiceImplementation> = {
    export: {
      path: signal.methodPath,
      requestStream: false,
      responseStream: false,
      requestSerialize: (payload: RawPayload) => payload,
      requestDeserialize: (payload: RawPayload) => payload,
      responseSerialize: (outcome: ExportOutcome) => Buffer.from(signal.encodeResponse(outcome)),
      responseDeserialize: (payload: RawPayload) => payload,
    },
  };
  grpcServer.addService(serviceDefinition, {
    export: async (
      call: grpc.ServerUnaryCall<RawPayload, ExportOutcome>,
      respond: grpc.sendUnaryData<ExportOutcome>,
    ) => {
      const authorizationHeader = call.metadata.get("authorization")[0]?.toString();
      let projectAccess: ProjectAccess | null;
      try {
        projectAccess = await dependencies.requestAuthenticator.authenticateRequest(
          authorizationHeader,
        );
      } catch (error) {
        if (!(error instanceof IdentityUnavailableError)) throw error;
        dependencies.logger.warn("Credentials could not be checked", { error });
        // OTLP exporters retry UNAVAILABLE, so the records are not lost while Identity is down.
        respond({
          code: grpc.status.UNAVAILABLE,
          details: "The credentials could not be checked. Retry later.",
        });
        return;
      }
      if (projectAccess === null) {
        respond({
          code: grpc.status.UNAUTHENTICATED,
          details: "A valid API key is required in the authorization metadata as a Bearer token.",
        });
        return;
      }
      if (!isRoleAtLeast(projectAccess.role, "editor")) {
        respond({
          code: grpc.status.PERMISSION_DENIED,
          details: "Sending telemetry takes the Role editor in the Project, as an API key has.",
        });
        return;
      }
      const { projectId } = projectAccess;
      try {
        const exportRequest = signal.decodeRequest(call.request);
        respond(null, await signal.ingest(projectId, exportRequest));
      } catch (error) {
        if (error instanceof OtlpPayloadError) {
          respond({ code: grpc.status.INVALID_ARGUMENT, details: error.message });
          return;
        }
        dependencies.logger.error(`Storing ${signal.recordsName.toLowerCase()} failed`, {
          error,
          projectId,
        });
        respond({
          code: grpc.status.UNAVAILABLE,
          details: `${signal.recordsName} could not be stored. Retry later.`,
        });
      }
    },
  });
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
