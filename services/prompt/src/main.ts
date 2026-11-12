import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityProjectLifecycleSource,
  createIdentityRequestAuthenticator,
  createIdentityServiceTokenSource,
  createServiceTokenClient,
  createStructuredLogger,
  readDatabaseMigrationMode,
  readDataLifecycleIntervalMilliseconds,
  readPortEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
  startPeriodicTask,
} from "@extispex/service-runtime";
import { createPromptService, openPromptDatabase } from "./create-service.ts";

const logger = createStructuredLogger("prompt");

const database = await openPromptDatabase(
  readRequiredEnvironmentVariable("PROMPT_DATABASE_URL"),
  readDatabaseMigrationMode(),
);
const identityClient = createHttpServiceClient(readRequiredEnvironmentVariable("IDENTITY_URL"));
const identityCredentials = {
  identityClient,
  clientId: "prompt",
  clientSecret: readRequiredEnvironmentVariable("IDENTITY_CLIENT_SECRET"),
};
const dataLifecycleIntervalMilliseconds = readDataLifecycleIntervalMilliseconds();
const promptService = createPromptService({
  database,
  requestAuthenticator: createIdentityRequestAuthenticator(identityCredentials),
  projectLifecycle: createIdentityProjectLifecycleSource(
    createServiceTokenClient(identityClient, createIdentityServiceTokenSource(identityCredentials)),
  ),
  logger,
  dataLifecycleIntervalMilliseconds,
});
const dataLifecycle = startPeriodicTask({
  taskName: "data lifecycle",
  intervalMilliseconds: dataLifecycleIntervalMilliseconds,
  runTask: promptService.runDataLifecycle,
  logger,
});

const httpServer = Deno.serve(
  {
    port: readPortEnvironmentVariable("PROMPT_PORT", 8081),
    onListen: ({ port }) => logger.info("HTTP server listening", { port }),
  },
  promptService.handleRequest,
);

runOnTerminationSignal(logger, async () => {
  await httpServer.shutdown();
  await dataLifecycle.stop();
  await database.close();
});
