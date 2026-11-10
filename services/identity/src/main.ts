import { MINIMUM_PASSWORD_LENGTH } from "@extispex/contracts";
import {
  createStructuredLogger,
  InvalidConfigurationError,
  readOptionalEnvironmentVariable,
  readPortEnvironmentVariable,
  readRequiredEnvironmentVariable,
  readSecretEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import {
  createFirstAdministratorIfNone,
  createFirstProjectIfNone,
  createIdentityService,
  createSigningKeyCipher,
  MINIMUM_CONFIGURED_KEY_LENGTH,
  openIdentityDatabase,
  parseServiceClients,
  protectStoredSigningKeys,
  readOidcSettings,
} from "./create-service.ts";

const logger = createStructuredLogger("identity");

const areLocalAccountsEnabled = readLocalAccountsSetting();
const serviceClientSecrets = parseServiceClients(
  readOptionalEnvironmentVariable("SERVICE_CLIENTS"),
);
const bootstrapProjectApiKey = readSecretEnvironmentVariable(
  "BOOTSTRAP_PROJECT_API_KEY",
  MINIMUM_CONFIGURED_KEY_LENGTH,
);
const bootstrapAdminEmail = readOptionalEnvironmentVariable("BOOTSTRAP_ADMIN_EMAIL");
const bootstrapAdminPassword = readSecretEnvironmentVariable(
  "BOOTSTRAP_ADMIN_PASSWORD",
  MINIMUM_PASSWORD_LENGTH,
);
if ((bootstrapAdminEmail === undefined) !== (bootstrapAdminPassword === undefined)) {
  throw new InvalidConfigurationError(
    "Set both BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, or neither.",
  );
}
if (bootstrapAdminEmail !== undefined && !areLocalAccountsEnabled) {
  throw new InvalidConfigurationError(
    "BOOTSTRAP_ADMIN_EMAIL creates a local account, which needs LOCAL_ACCOUNTS=enabled.",
  );
}

const signingKeyCipher = await createSigningKeyCipher(
  readRequiredEnvironmentVariable("MASTER_KEY"),
);
const database = await openIdentityDatabase(
  readRequiredEnvironmentVariable("IDENTITY_DATABASE_URL"),
);
await protectStoredSigningKeys(database, signingKeyCipher);
if (bootstrapProjectApiKey !== undefined) {
  const firstProject = await createFirstProjectIfNone(database, bootstrapProjectApiKey);
  if (firstProject !== null) {
    logger.info("Created the first Project with BOOTSTRAP_PROJECT_API_KEY", {
      projectId: firstProject.id,
      projectName: firstProject.name,
    });
  }
}
// After the first Project, so that the first administrator gets the Role admin in it.
if (bootstrapAdminEmail !== undefined && bootstrapAdminPassword !== undefined) {
  const firstAdministrator = await createFirstAdministratorIfNone(database, {
    email: bootstrapAdminEmail,
    password: bootstrapAdminPassword,
  });
  if (firstAdministrator !== null) {
    logger.info("Created the first administrator with BOOTSTRAP_ADMIN_EMAIL", {
      email: firstAdministrator.email,
    });
  }
}

const identityService = createIdentityService({
  database,
  signingKeyCipher,
  areLocalAccountsEnabled,
  serviceClientSecrets,
  oidcSettings: readOidcSettings(readOptionalEnvironmentVariable),
  logger,
});

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

/**
 * `LOCAL_ACCOUNTS=enabled` lets users sign in with a password stored by Identity. It is off by
 * default here: production signs users in through the company's identity provider.
 */
function readLocalAccountsSetting(): boolean {
  const configuredValue = readOptionalEnvironmentVariable("LOCAL_ACCOUNTS") ?? "disabled";
  if (configuredValue !== "enabled" && configuredValue !== "disabled") {
    throw new InvalidConfigurationError(
      `LOCAL_ACCOUNTS must be "enabled" or "disabled", got "${configuredValue}".`,
    );
  }
  return configuredValue === "enabled";
}
