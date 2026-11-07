/**
 * Local deployment: every service runs in this one process, each with its own SQLite file.
 * Services call each other through their request handlers instead of the network.
 */
import { createGatewayService } from "@extispex/gateway-service";
import {
  createFirstProjectIfNone,
  createIdentityService,
  generateApiKey,
  generateInstanceAdminKey,
  type IdentityDatabase,
  MINIMUM_CONFIGURED_KEY_LENGTH,
  openIdentityDatabase,
} from "@extispex/identity-service";
import { createPromptService, openPromptDatabase } from "@extispex/prompt-service";
import { createInProcessServiceClient } from "@extispex/service-client";
import {
  createIdentityProjectResolver,
  createStructuredLogger,
  InvalidConfigurationError,
  readOptionalEnvironmentVariable,
  readPortEnvironmentVariable,
  readSecretEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  bindOtlpGrpcServer,
  createTelemetryService,
  type GrpcTlsFiles,
  openTelemetryDatabase,
  shutdownOtlpGrpcServer,
} from "@extispex/telemetry-service";

const logger = createStructuredLogger("all-in-one");
const dataDirectory = readOptionalEnvironmentVariable("DATA_DIRECTORY") ?? "./data";
await Deno.mkdir(dataDirectory, { recursive: true });

const identityDatabase = await openIdentityDatabase(`sqlite:${dataDirectory}/identity.sqlite`);
const identityService = createIdentityService({
  database: identityDatabase,
  instanceAdminKey: await readOrGenerateInstanceAdminKey(),
  logger: createStructuredLogger("identity"),
});
await createFirstProjectOnFirstStart(identityDatabase);
const projectResolver = createIdentityProjectResolver({
  identityClient: createInProcessServiceClient(identityService.handleRequest),
});

const telemetryDatabase = await openTelemetryDatabase(`sqlite:${dataDirectory}/telemetry.sqlite`);
const telemetryService = createTelemetryService({
  database: telemetryDatabase,
  projectResolver,
  logger: createStructuredLogger("telemetry"),
});

const promptDatabase = await openPromptDatabase(`sqlite:${dataDirectory}/prompt.sqlite`);
const promptService = createPromptService({
  database: promptDatabase,
  projectResolver,
  logger: createStructuredLogger("prompt"),
});

const gatewayService = createGatewayService({
  serviceClients: {
    telemetry: createInProcessServiceClient(telemetryService.handleRequest),
    prompt: createInProcessServiceClient(promptService.handleRequest),
    identity: createInProcessServiceClient(identityService.handleRequest),
  },
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
  await Promise.all([telemetryDatabase.close(), promptDatabase.close(), identityDatabase.close()]);
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

/**
 * `INSTANCE_ADMIN_KEY` when set. Otherwise a key generated on first start into the data directory,
 * like the encryption master key, so that the local image needs no configuration.
 */
async function readOrGenerateInstanceAdminKey(): Promise<string> {
  const configuredKey = readSecretEnvironmentVariable(
    "INSTANCE_ADMIN_KEY",
    MINIMUM_CONFIGURED_KEY_LENGTH,
  );
  if (configuredKey !== undefined) return configuredKey;
  const keyFile = `${dataDirectory}/instance-admin-key`;
  try {
    const storedKey = (await Deno.readTextFile(keyFile)).trim();
    if (storedKey.length < MINIMUM_CONFIGURED_KEY_LENGTH) {
      throw new InvalidConfigurationError(
        `${keyFile} must hold at least ${MINIMUM_CONFIGURED_KEY_LENGTH} characters.`,
      );
    }
    return storedKey;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const generatedKey = generateInstanceAdminKey();
  await Deno.writeTextFile(keyFile, `${generatedKey}\n`, { mode: 0o600, createNew: true });
  logger.info(
    "Generated the Instance admin key. Use it under Projects in the UI to manage Projects and " +
      "API keys. Set INSTANCE_ADMIN_KEY to choose your own.",
    { instanceAdminKey: generatedKey, keyFile },
  );
  return generatedKey;
}

/**
 * A fresh instance gets the Project `Default` with `BOOTSTRAP_PROJECT_API_KEY`, or with a generated
 * key that is logged only this once.
 */
async function createFirstProjectOnFirstStart(database: IdentityDatabase): Promise<void> {
  const configuredKey = readSecretEnvironmentVariable(
    "BOOTSTRAP_PROJECT_API_KEY",
    MINIMUM_CONFIGURED_KEY_LENGTH,
  );
  const firstApiKey = configuredKey ?? generateApiKey();
  const firstProject = await createFirstProjectIfNone(database, firstApiKey);
  if (firstProject === null) return;
  if (configuredKey !== undefined) {
    logger.info("Created the first Project with BOOTSTRAP_PROJECT_API_KEY", {
      projectName: firstProject.name,
    });
    return;
  }
  logger.info(
    "Created the first Project. Its API key is shown only now; create more under Projects in the UI.",
    { projectName: firstProject.name, apiKey: firstApiKey },
  );
}
