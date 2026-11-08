import type { ServiceRequestHandler } from "@extispex/service-client";
import { createServiceHttpApp, type StructuredLogger } from "@extispex/service-runtime";
import { DEFAULT_PASSWORD_HASH_ITERATIONS } from "./accounts/password-hashing.ts";
import { registerInternalTokenRoutes } from "./access-tokens/internal-token-routes.ts";
import { createAccessTokenSigner } from "./access-tokens/signing-keys.ts";
import { registerAccessRoutes } from "./access/access-routes.ts";
import { type IdentityEnvironment, requireSignedInUser } from "./access/user-authentication.ts";
import { registerProjectRoutes } from "./projects/project-routes.ts";
import { registerSignInRoutes } from "./sign-in/sign-in-routes.ts";
import { createAccessRepository } from "./storage/access-repository.ts";
import type { IdentityDatabase } from "./storage/identity-database.ts";
import { createProjectRepository } from "./storage/project-repository.ts";
import { createSignInRepository } from "./storage/sign-in-repository.ts";

export {
  createFirstAdministratorIfNone,
  DEFAULT_FIRST_ADMINISTRATOR_EMAIL,
  type FirstAdministrator,
} from "./accounts/first-administrator.ts";
export { parseServiceClients } from "./accounts/service-clients.ts";
export {
  generateApiKey,
  generateRandomCharacters,
  generateServiceClientSecret,
  MINIMUM_CONFIGURED_KEY_LENGTH,
} from "./api-keys/api-key-secrets.ts";
export { createFirstProjectIfNone, FIRST_PROJECT_NAME } from "./projects/first-project.ts";
export { type IdentityDatabase, openIdentityDatabase } from "./storage/identity-database.ts";

export interface IdentityServiceDependencies {
  database: IdentityDatabase;
  /** Whether users may sign in with a password stored by Identity, from `LOCAL_ACCOUNTS`. */
  areLocalAccountsEnabled: boolean;
  /** Each service's client secret by client ID, from `SERVICE_CLIENTS`. */
  serviceClientSecrets: ReadonlyMap<string, string>;
  logger: StructuredLogger;
  readCurrentTime?: () => Date;
  /** PBKDF2 iterations for new password hashes; tests lower it to stay fast. */
  passwordHashIterations?: number;
}

export interface IdentityService {
  /**
   * Handles sign-in, users, Groups, Roles, Projects and API keys, the internal endpoints for
   * tokens and API key resolution, the OpenAPI document and health checks.
   */
  handleRequest: ServiceRequestHandler;
}

export function createIdentityService(dependencies: IdentityServiceDependencies): IdentityService {
  const app = createServiceHttpApp<IdentityEnvironment>({
    apiTitle: "Extispex: Identity API",
    logger: dependencies.logger,
  });
  const readCurrentTime = dependencies.readCurrentTime ?? (() => new Date());
  const passwordHashIterations = dependencies.passwordHashIterations ??
    DEFAULT_PASSWORD_HASH_ITERATIONS;
  const projectRepository = createProjectRepository(dependencies.database);
  const accessRepository = createAccessRepository(dependencies.database);
  const accessTokenSigner = createAccessTokenSigner(dependencies.database, readCurrentTime);

  registerInternalTokenRoutes(app, {
    projectRepository,
    accessTokenSigner,
    serviceClientSecrets: dependencies.serviceClientSecrets,
  });
  app.use("/v1/*", requireSignedInUser(accessTokenSigner, accessRepository));
  registerSignInRoutes(app, {
    accessRepository,
    projectRepository,
    signInRepository: createSignInRepository(dependencies.database),
    accessTokenSigner,
    areLocalAccountsEnabled: dependencies.areLocalAccountsEnabled,
    passwordHashIterations,
    readCurrentTime,
  });
  registerAccessRoutes(app, {
    accessRepository,
    projectRepository,
    areLocalAccountsEnabled: dependencies.areLocalAccountsEnabled,
    passwordHashIterations,
    readCurrentTime,
  });
  registerProjectRoutes(app, { projectRepository, accessRepository, readCurrentTime });
  return { handleRequest: (request) => app.fetch(request) };
}
