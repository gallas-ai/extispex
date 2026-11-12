import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityRequestAuthenticator,
  createSecretCipher,
  createStructuredLogger,
  readDatabaseMigrationMode,
  readPortEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  createEvaluationApiService,
  LLM_PROVIDER_API_KEY_CIPHER_PURPOSE,
  openEvaluationDatabase,
  openJobQueue,
  REPORT_CHANNEL_CIPHER_PURPOSE,
  TARGET_CREDENTIAL_CIPHER_PURPOSE,
} from "./create-service.ts";

const logger = createStructuredLogger("evaluation-api");

const databaseUrl = readRequiredEnvironmentVariable("EVALUATION_DATABASE_URL");
const database = await openEvaluationDatabase(
  databaseUrl,
  readDatabaseMigrationMode(),
);
const jobQueue = await openJobQueue(databaseUrl, database, logger);
const masterKey = readRequiredEnvironmentVariable("MASTER_KEY");
const evaluationApi = createEvaluationApiService({
  database,
  jobQueue,
  targetCredentialCipher: await createSecretCipher(masterKey, TARGET_CREDENTIAL_CIPHER_PURPOSE),
  reportChannelCipher: await createSecretCipher(masterKey, REPORT_CHANNEL_CIPHER_PURPOSE),
  llmProviderApiKeyCipher: await createSecretCipher(
    masterKey,
    LLM_PROVIDER_API_KEY_CIPHER_PURPOSE,
  ),
  requestAuthenticator: createIdentityRequestAuthenticator({
    identityClient: createHttpServiceClient(readRequiredEnvironmentVariable("IDENTITY_URL")),
    clientId: "evaluation",
    clientSecret: readRequiredEnvironmentVariable("IDENTITY_CLIENT_SECRET"),
  }),
  logger,
});

const httpServer = Deno.serve(
  {
    port: readPortEnvironmentVariable("EVALUATION_PORT", 8083),
    onListen: ({ port }) => logger.info("HTTP server listening", { port }),
  },
  evaluationApi.handleRequest,
);

runOnTerminationSignal(logger, async () => {
  await httpServer.shutdown();
  await jobQueue.stop();
  await database.close();
});
