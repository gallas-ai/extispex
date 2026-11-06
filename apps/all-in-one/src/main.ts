/**
 * Local deployment: every service runs in this one process, each with its own SQLite file.
 * Services call each other through their request handlers instead of the network.
 */
import { createGatewayService } from "@evaluation-telemetry/gateway-service";
import { createInProcessServiceClient } from "@evaluation-telemetry/service-client";
import {
  createStructuredLogger,
  readOptionalEnvironmentVariable,
  readPortEnvironmentVariable,
  runOnTerminationSignal,
} from "@evaluation-telemetry/service-runtime";
import {
  bindOtlpGrpcServer,
  createStaticApiKeyProjectResolver,
  createTelemetryService,
  type GrpcTlsFiles,
  openTelemetryDatabase,
  shutdownOtlpGrpcServer,
} from "@evaluation-telemetry/telemetry-service";

const DEFAULT_LOCAL_API_KEYS = "local-development-key=default";

const logger = createStructuredLogger("all-in-one");
const dataDirectory = readOptionalEnvironmentVariable("DATA_DIRECTORY") ?? "./data";
await Deno.mkdir(dataDirectory, { recursive: true });

const staticApiKeys = readOptionalEnvironmentVariable("STATIC_API_KEYS");
if (staticApiKeys === undefined) {
  logger.warn(
    "Using the built-in local API key. Set STATIC_API_KEYS before exposing this instance.",
    {
      apiKey: "local-development-key",
    },
  );
}
const projectResolver = createStaticApiKeyProjectResolver(staticApiKeys ?? DEFAULT_LOCAL_API_KEYS);

const telemetryDatabase = await openTelemetryDatabase(`sqlite:${dataDirectory}/telemetry.sqlite`);
const telemetryService = createTelemetryService({
  database: telemetryDatabase,
  projectResolver,
  logger: createStructuredLogger("telemetry"),
});

const gatewayService = createGatewayService({
  telemetryClient: createInProcessServiceClient(telemetryService.handleRequest),
  webAssetsDirectory: readOptionalEnvironmentVariable("WEB_ASSETS_DIRECTORY") ??
    new URL("../../web/dist", import.meta.url).pathname,
  logger: createStructuredLogger("gateway"),
});

const otlpHttpServer = Deno.serve(
  {
    port: readPortEnvironmentVariable("TELEMETRY_HTTP_PORT", 4318),
    onListen: ({ port }) => logger.info("OTLP/HTTP listening", { port }),
  },
  telemetryService.handleRequest,
);

const grpcTlsFiles = readGrpcTlsFiles();
const grpcServer = telemetryService.createGrpcServer();
const grpcPort = await bindOtlpGrpcServer(
  grpcServer,
  readPortEnvironmentVariable("TELEMETRY_GRPC_PORT", 4317),
  grpcTlsFiles,
);
logger.info("OTLP/gRPC listening", { port: grpcPort, tls: grpcTlsFiles !== null });

const gatewayServer = Deno.serve(
  {
    port: readPortEnvironmentVariable("GATEWAY_PORT", 8080),
    onListen: ({ port }) => logger.info("UI and REST API listening", { port }),
  },
  gatewayService.handleRequest,
);

runOnTerminationSignal(logger, async () => {
  await Promise.all([
    gatewayServer.shutdown(),
    otlpHttpServer.shutdown(),
    shutdownOtlpGrpcServer(grpcServer),
  ]);
  await telemetryDatabase.close();
});

function readGrpcTlsFiles(): GrpcTlsFiles | null {
  const certificateChainFile = readOptionalEnvironmentVariable(
    "TELEMETRY_GRPC_TLS_CERTIFICATE_FILE",
  );
  const privateKeyFile = readOptionalEnvironmentVariable("TELEMETRY_GRPC_TLS_PRIVATE_KEY_FILE");
  if (certificateChainFile === undefined || privateKeyFile === undefined) {
    return null;
  }
  return { certificateChainFile, privateKeyFile };
}
