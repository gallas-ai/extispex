import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityRequestAuthenticator,
  createSecretCipher,
  createStructuredLogger,
  readPortEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  createEvaluationApiService,
  openEvaluationDatabase,
  openJobQueue,
  TARGET_CREDENTIAL_CIPHER_PURPOSE,
} from "./create-service.ts";

const logger = createStructuredLogger("evaluation-api");

const databaseUrl = readRequiredEnvironmentVariable("EVALUATION_DATABASE_URL");
const database = await openEvaluationDatabase(databaseUrl);
const jobQueue = await openJobQueue(databaseUrl, database, logger);
const evaluationApi = createEvaluationApiService({
  database,
  jobQueue,
  targetCredentialCipher: await createSecretCipher(
    readRequiredEnvironmentVariable("MASTER_KEY"),
    TARGET_CREDENTIAL_CIPHER_PURPOSE,
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
