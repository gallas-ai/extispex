/**
 * Local deployment: every service runs in this one process, each with its own SQLite file.
 * Services call each other through their request handlers instead of the network.
 */
import {
  createEvaluationApiService,
  createEvaluationWorker,
  DEFAULT_REPORT_RETRY_DELAY_MILLISECONDS,
  DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  DEFAULT_TRACE_COMPLETION_TIMING,
  openEvaluationDatabase,
  openJobQueue,
  REPORT_CHANNEL_CIPHER_PURPOSE,
  TARGET_CREDENTIAL_CIPHER_PURPOSE,
} from "@extispex/evaluation-service";
import { createGatewayService } from "@extispex/gateway-service";
import { MINIMUM_PASSWORD_LENGTH } from "@extispex/contracts";
import {
  createFirstAdministratorIfNone,
  createFirstProjectIfNone,
  createIdentityService,
  createSigningKeyCipher,
  DEFAULT_FIRST_ADMINISTRATOR_EMAIL,
  generateApiKey,
  generateRandomCharacters,
  generateServiceClientSecret,
  type IdentityDatabase,
  MINIMUM_CONFIGURED_KEY_LENGTH,
  openIdentityDatabase,
  protectStoredSigningKeys,
  readOidcSettings,
} from "@extispex/identity-service";
import { createPromptService, openPromptDatabase } from "@extispex/prompt-service";
import { createInProcessServiceClient } from "@extispex/service-client";
import {
  createIdentityProjectLifecycleSource,
  createIdentityRequestAuthenticator,
  createIdentityServiceTokenSource,
  createSecretCipher,
  createServiceTokenClient,
  createStructuredLogger,
  generateMasterKey,
  readDataLifecycleIntervalMilliseconds,
  readOptionalEnvironmentVariable,
  readPortEnvironmentVariable,
  readPositiveIntegerEnvironmentVariable,
  readSecretEnvironmentVariable,
  readTrustedProxyCount,
  runOnTerminationSignal,
  startPeriodicTask,
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
const masterKey = await readOrCreateMasterKey();

const identityDatabase = await openIdentityDatabase(`sqlite:${dataDirectory}/identity.sqlite`);
// The services in this process get service tokens like separate services do, with secrets that
// exist only in memory, so nothing needs configuring.
const serviceClientSecrets = new Map([
  ["telemetry", generateServiceClientSecret()],
  ["prompt", generateServiceClientSecret()],
  ["evaluation", generateServiceClientSecret()],
]);
const signingKeyCipher = await createSigningKeyCipher(masterKey);
const dataLifecycleIntervalMilliseconds = readDataLifecycleIntervalMilliseconds();
await protectStoredSigningKeys(identityDatabase, signingKeyCipher);
const identityService = createIdentityService({
  database: identityDatabase,
  signingKeyCipher,
  // Local accounts are how people sign in to the local image.
  areLocalAccountsEnabled: true,
  serviceClientSecrets,
  oidcSettings: readOidcSettings(readOptionalEnvironmentVariable),
  logger: createStructuredLogger("identity"),
  dataLifecycleIntervalMilliseconds,
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
const createServiceTokens = (clientId: string) =>
  createIdentityServiceTokenSource({
    identityClient,
    clientId,
    clientSecret: serviceClientSecrets.get(clientId)!,
  });
/** Identity's Retention Periods and deleted Projects, asked with the service's own token. */
const createProjectLifecycle = (clientId: string) =>
  createIdentityProjectLifecycleSource(
    createServiceTokenClient(identityClient, createServiceTokens(clientId)),
  );

const telemetryDatabase = await openTelemetryDatabase(`sqlite:${dataDirectory}/telemetry.sqlite`);
const telemetryService = createTelemetryService({
  database: telemetryDatabase,
  requestAuthenticator: createRequestAuthenticator("telemetry"),
  projectLifecycle: createProjectLifecycle("telemetry"),
  logger: createStructuredLogger("telemetry"),
  dataLifecycleIntervalMilliseconds,
});

const promptDatabase = await openPromptDatabase(`sqlite:${dataDirectory}/prompt.sqlite`);
const promptService = createPromptService({
  database: promptDatabase,
  requestAuthenticator: createRequestAuthenticator("prompt"),
  projectLifecycle: createProjectLifecycle("prompt"),
  logger: createStructuredLogger("prompt"),
  dataLifecycleIntervalMilliseconds,
});

const evaluationDatabaseUrl = `sqlite:${dataDirectory}/evaluation.sqlite`;
const evaluationDatabase = await openEvaluationDatabase(evaluationDatabaseUrl);
const evaluationLogger = createStructuredLogger("evaluation");
const evaluationJobQueue = await openJobQueue(
  evaluationDatabaseUrl,
  evaluationDatabase,
  evaluationLogger,
);
const targetCredentialCipher = await createSecretCipher(
  masterKey,
  TARGET_CREDENTIAL_CIPHER_PURPOSE,
);
const reportChannelCipher = await createSecretCipher(masterKey, REPORT_CHANNEL_CIPHER_PURPOSE);
const gatewayPort = readPortEnvironmentVariable("GATEWAY_PORT", 8080);
const evaluationApiService = createEvaluationApiService({
  database: evaluationDatabase,
  jobQueue: evaluationJobQueue,
  targetCredentialCipher,
  reportChannelCipher,
  requestAuthenticator: createRequestAuthenticator("evaluation"),
  logger: evaluationLogger,
});
const evaluationWorker = createEvaluationWorker({
  database: evaluationDatabase,
  jobQueue: evaluationJobQueue,
  targetCredentialCipher,
  // The local image runs on one person's machine, where Targets are usually on that machine.
  targetAllowedDestinations: readOptionalEnvironmentVariable(
    "EVALUATION_TARGET_ALLOWED_DESTINATIONS",
  ) ?? "*",
  targetTimeoutMilliseconds: readPositiveIntegerEnvironmentVariable(
    "EVALUATION_TARGET_TIMEOUT_MILLISECONDS",
    DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  ),
  reportChannelCipher,
  // Like Targets, the SMTP server and the webhook are the user's own choice on their machine.
  reportAllowedDestinations: readOptionalEnvironmentVariable(
    "EVALUATION_REPORT_ALLOWED_DESTINATIONS",
  ) ?? "*",
  publicUiUrl: readOptionalEnvironmentVariable("PUBLIC_UI_URL") ??
    `http://localhost:${gatewayPort}`,
  reportRetryDelayMilliseconds: readPositiveIntegerEnvironmentVariable(
    "EVALUATION_REPORT_RETRY_DELAY_MILLISECONDS",
    DEFAULT_REPORT_RETRY_DELAY_MILLISECONDS,
  ),
  telemetryService: createInProcessServiceClient(telemetryService.handleRequest),
  serviceTokens: createServiceTokens("evaluation"),
  projectLifecycle: createProjectLifecycle("evaluation"),
  dataLifecycleIntervalMilliseconds,
  logger: evaluationLogger,
  traceCompletionTiming: {
    pollIntervalMilliseconds: readPositiveIntegerEnvironmentVariable(
      "EVALUATION_TELEMETRY_POLL_INTERVAL_MILLISECONDS",
      DEFAULT_TRACE_COMPLETION_TIMING.pollIntervalMilliseconds,
    ),
    rootSpanSettleMilliseconds: readPositiveIntegerEnvironmentVariable(
      "EVALUATION_ROOT_SPAN_SETTLE_MILLISECONDS",
      DEFAULT_TRACE_COMPLETION_TIMING.rootSpanSettleMilliseconds,
    ),
    rootSpanTimeoutMilliseconds: readPositiveIntegerEnvironmentVariable(
      "EVALUATION_ROOT_SPAN_TIMEOUT_MILLISECONDS",
      DEFAULT_TRACE_COMPLETION_TIMING.rootSpanTimeoutMilliseconds,
    ),
  },
});
await evaluationWorker.start();
const dataLifecycles = [
  { name: "identity", runTask: identityService.runDataLifecycle },
  { name: "telemetry", runTask: telemetryService.runDataLifecycle },
  { name: "prompt", runTask: promptService.runDataLifecycle },
  { name: "evaluation", runTask: evaluationWorker.runDataLifecycle },
].map(({ name, runTask }) =>
  startPeriodicTask({
    taskName: `${name} data lifecycle`,
    intervalMilliseconds: dataLifecycleIntervalMilliseconds,
    runTask,
    logger,
  })
);

const gatewayService = createGatewayService({
  serviceClients: {
    telemetry: createInProcessServiceClient(telemetryService.handleRequest),
    prompt: createInProcessServiceClient(promptService.handleRequest),
    identity: createInProcessServiceClient(identityService.handleRequest),
    evaluation: createInProcessServiceClient(evaluationApiService.handleRequest),
  },
  webAssetsDirectory: readOptionalEnvironmentVariable("WEB_ASSETS_DIRECTORY") ??
    new URL("../../web/dist", import.meta.url).pathname,
  trustedProxyCount: readTrustedProxyCount(),
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
    port: gatewayPort,
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
  await Promise.all(dataLifecycles.map((dataLifecycle) => dataLifecycle.stop()));
  await evaluationWorker.stop();
  await Promise.all([
    telemetryDatabase.close(),
    promptDatabase.close(),
    identityDatabase.close(),
    evaluationDatabase.close(),
  ]);
});

/** `MASTER_KEY`, or the key in the data directory, created there on first start. */
async function readOrCreateMasterKey(): Promise<string> {
  const configuredKey = readOptionalEnvironmentVariable("MASTER_KEY");
  if (configuredKey !== undefined) return configuredKey;
  const masterKeyFile = `${dataDirectory}/master-key`;
  try {
    return (await Deno.readTextFile(masterKeyFile)).trim();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const generatedKey = generateMasterKey();
  await Deno.writeTextFile(masterKeyFile, `${generatedKey}\n`, { mode: 0o600, createNew: true });
  logger.info("Generated the master key", { masterKeyFile });
  return generatedKey;
}

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
