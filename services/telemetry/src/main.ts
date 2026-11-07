import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityProjectResolver,
  createStructuredLogger,
  readOptionalEnvironmentVariable,
  readPortEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  bindOtlpGrpcServer,
  createTelemetryService,
  type GrpcTlsFiles,
  openTelemetryDatabase,
  shutdownOtlpGrpcServer,
} from "./create-service.ts";

const logger = createStructuredLogger("telemetry");

const database = await openTelemetryDatabase(
  readRequiredEnvironmentVariable("TELEMETRY_DATABASE_URL"),
);
const telemetryService = createTelemetryService({
  database,
  projectResolver: createIdentityProjectResolver({
    identityClient: createHttpServiceClient(readRequiredEnvironmentVariable("IDENTITY_URL")),
  }),
  logger,
});

const httpServer = Deno.serve(
  {
    port: readPortEnvironmentVariable("TELEMETRY_HTTP_PORT", 4318),
    onListen: ({ port }) => logger.info("HTTP server listening", { port }),
  },
  telemetryService.handleRequest,
);

const grpcServer = telemetryService.createGrpcServer();
const grpcPort = await bindOtlpGrpcServer(
  grpcServer,
  readPortEnvironmentVariable("TELEMETRY_GRPC_PORT", 4317),
  readGrpcTlsFiles(),
);
logger.info("gRPC server listening", { port: grpcPort, tls: readGrpcTlsFiles() !== null });

runOnTerminationSignal(logger, async () => {
  await Promise.all([httpServer.shutdown(), shutdownOtlpGrpcServer(grpcServer)]);
  await database.close();
});

function readGrpcTlsFiles(): GrpcTlsFiles | null {
  const certificateChainFile = readOptionalEnvironmentVariable(
    "TELEMETRY_GRPC_TLS_CERTIFICATE_FILE",
  );
  const privateKeyFile = readOptionalEnvironmentVariable("TELEMETRY_GRPC_TLS_PRIVATE_KEY_FILE");
  if (certificateChainFile === undefined && privateKeyFile === undefined) {
    return null;
  }
  if (certificateChainFile === undefined || privateKeyFile === undefined) {
    throw new Error(
      "Set both TELEMETRY_GRPC_TLS_CERTIFICATE_FILE and TELEMETRY_GRPC_TLS_PRIVATE_KEY_FILE, or neither.",
    );
  }
  return { certificateChainFile, privateKeyFile };
}
