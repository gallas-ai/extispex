import {
  createStructuredLogger,
  InvalidConfigurationError,
  readPortEnvironmentVariable,
  readRequiredEnvironmentVariable,
  readSecretEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  createFirstProjectIfNone,
  createIdentityService,
  MINIMUM_CONFIGURED_KEY_LENGTH,
  openIdentityDatabase,
} from "./create-service.ts";

const logger = createStructuredLogger("identity");

const instanceAdminKey = readSecretEnvironmentVariable(
  "INSTANCE_ADMIN_KEY",
  MINIMUM_CONFIGURED_KEY_LENGTH,
);
if (instanceAdminKey === undefined) {
  throw new InvalidConfigurationError("Environment variable INSTANCE_ADMIN_KEY is required.");
}
const bootstrapProjectApiKey = readSecretEnvironmentVariable(
  "BOOTSTRAP_PROJECT_API_KEY",
  MINIMUM_CONFIGURED_KEY_LENGTH,
);

const database = await openIdentityDatabase(
  readRequiredEnvironmentVariable("IDENTITY_DATABASE_URL"),
);
if (bootstrapProjectApiKey !== undefined) {
  const firstProject = await createFirstProjectIfNone(database, bootstrapProjectApiKey);
  if (firstProject !== null) {
    logger.info("Created the first Project with BOOTSTRAP_PROJECT_API_KEY", {
      projectId: firstProject.id,
      projectName: firstProject.name,
    });
  }
}

const identityService = createIdentityService({ database, instanceAdminKey, logger });

const httpServer = Deno.serve(
  {
    port: readPortEnvironmentVariable("IDENTITY_PORT", 8082),
    onListen: ({ port }) => logger.info("HTTP server listening", { port }),
  },
  identityService.handleRequest,
);

runOnTerminationSignal(logger, async () => {
  await httpServer.shutdown();
  await database.close();
});
