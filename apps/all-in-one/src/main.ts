/**
 * Local deployment: every service runs in this one process, each with its own SQLite file.
 * Services call each other through their request handlers instead of the network.
 */
import { createGatewayService } from "@extispex/gateway-service";
import { MINIMUM_PASSWORD_LENGTH } from "@extispex/contracts";
import {
  createFirstAdministratorIfNone,
  createFirstProjectIfNone,
  createIdentityService,
  DEFAULT_FIRST_ADMINISTRATOR_EMAIL,
  generateApiKey,
  generateRandomCharacters,
  generateServiceClientSecret,
  type IdentityDatabase,
  MINIMUM_CONFIGURED_KEY_LENGTH,
  openIdentityDatabase,
} from "@extispex/identity-service";
import { createPromptService, openPromptDatabase } from "@extispex/prompt-service";
import { createInProcessServiceClient } from "@extispex/service-client";
import {
  createIdentityRequestAuthenticator,
  createStructuredLogger,
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
// The services in this process get service tokens like separate services do, with secrets that
// exist only in memory, so nothing needs configuring.
const serviceClientSecrets = new Map([
  ["telemetry", generateServiceClientSecret()],
  ["prompt", generateServiceClientSecret()],
]);
const identityService = createIdentityService({
  database: identityDatabase,
  // Local accounts are how people sign in to the local image.
  areLocalAccountsEnabled: true,
  serviceClientSecrets,
  logger: createStructuredLogger("identity"),
});
await createFirstProjectOnFirstStart(identityDatabase);
await createFirstAdministratorOnFirstStart(identityDatabase);
const identityClient = createInProcessServiceClient(identityService.handleRequest);
const createRequestAuthenticator = (clientId: string) =>
  createIdentityRequestAuthenticator({
    identityClient,
    clientId,
    clientSecret: serviceClientSecrets.get(clientId)!,
  });

const telemetryDatabase = await openTelemetryDatabase(`sqlite:${dataDirectory}/telemetry.sqlite`);
const telemetryService = createTelemetryService({
  database: telemetryDatabase,
  requestAuthenticator: createRequestAuthenticator("telemetry"),
  logger: createStructuredLogger("telemetry"),
});

const promptDatabase = await openPromptDatabase(`sqlite:${dataDirectory}/prompt.sqlite`);
const promptService = createPromptService({
  database: promptDatabase,
  requestAuthenticator: createRequestAuthenticator("prompt"),
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

/**
 * A fresh instance gets its first user, an Instance admin with the Role admin in `Default`. The
 * email defaults to `admin@extispex.local`; the password comes from `BOOTSTRAP_ADMIN_PASSWORD`, or
 * is generated, logged this once and kept in the data directory.
 */
async function createFirstAdministratorOnFirstStart(database: IdentityDatabase): Promise<void> {
  const email = readOptionalEnvironmentVariable("BOOTSTRAP_ADMIN_EMAIL") ??
    DEFAULT_FIRST_ADMINISTRATOR_EMAIL;
  const configuredPassword = readSecretEnvironmentVariable(
    "BOOTSTRAP_ADMIN_PASSWORD",
    MINIMUM_PASSWORD_LENGTH,
  );
  const password = configuredPassword ?? generateRandomCharacters();
  const firstAdministrator = await createFirstAdministratorIfNone(database, { email, password });
  if (firstAdministrator === null) return;
  if (configuredPassword !== undefined) {
    logger.info("Created the first administrator with BOOTSTRAP_ADMIN_PASSWORD", { email });
    return;
  }
  const passwordFile = `${dataDirectory}/initial-admin-password`;
  await Deno.writeTextFile(passwordFile, `${password}\n`, { mode: 0o600 });
  logger.info(
    "Created the first administrator. Sign in to the UI with this email and password, and add " +
      "users under Access.",
    { email, password, passwordFile },
  );
}
