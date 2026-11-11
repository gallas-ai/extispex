import type { ServiceRequestHandler } from "@extispex/service-client";
import { createServiceHttpApp, type StructuredLogger } from "@extispex/service-runtime";
import { DEFAULT_PASSWORD_HASH_ITERATIONS } from "./accounts/password-hashing.ts";
import { registerInternalTokenRoutes } from "./access-tokens/internal-token-routes.ts";
import { createAccessTokenSigner } from "./access-tokens/signing-keys.ts";
import { registerAccessRoutes } from "./access/access-routes.ts";
import { type IdentityEnvironment, requireSignedInUser } from "./access/user-authentication.ts";
import { registerDirectoryRoutes } from "./directory/directory-routes.ts";
import { createOidcProvider } from "./oidc/oidc-provider.ts";
import type { OidcSettings } from "./oidc/oidc-settings.ts";
import { registerOidcSignInRoutes } from "./oidc/oidc-sign-in-routes.ts";
import { registerProjectRoutes } from "./projects/project-routes.ts";
import { registerScimRoutes } from "./scim/scim-routes.ts";
import { createBrowserSignIns } from "./sign-in/browser-sign-ins.ts";
import { createPasswordAttemptThrottle } from "./sign-in/password-attempt-throttle.ts";
import { registerSignInRoutes } from "./sign-in/sign-in-routes.ts";
import { createAccessRepository } from "./storage/access-repository.ts";
import { createDirectoryImportRepository } from "./storage/directory-import-repository.ts";
import { createDirectoryTokenRepository } from "./storage/directory-token-repository.ts";
import type { IdentityDatabase } from "./storage/identity-database.ts";
import { createOidcRepository } from "./storage/oidc-repository.ts";
import { createProjectRepository } from "./storage/project-repository.ts";
import { createScimRepository } from "./storage/scim-repository.ts";
import { createSignInRepository } from "./storage/sign-in-repository.ts";
import { createSignInThrottleRepository } from "./storage/sign-in-throttle-repository.ts";

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
export { type OidcSettings, readOidcSettings } from "./oidc/oidc-settings.ts";
export { createFirstProjectIfNone, FIRST_PROJECT_NAME } from "./projects/first-project.ts";
export { type IdentityDatabase, openIdentityDatabase } from "./storage/identity-database.ts";

export interface IdentityServiceDependencies {
  database: IdentityDatabase;
  /** Whether users may sign in with a password stored by Identity, from `LOCAL_ACCOUNTS`. */
  areLocalAccountsEnabled: boolean;
  /** Each service's client secret by client ID, from `SERVICE_CLIENTS`. */
  serviceClientSecrets: ReadonlyMap<string, string>;
  /** Sign-in through the company's identity provider, from the `OIDC_*` variables; null for none. */
  oidcSettings?: OidcSettings | null;
  /** How Identity calls the identity provider; tests answer with a fake one. */
  fetchFromOidcProvider?: typeof fetch;
  logger: StructuredLogger;
  readCurrentTime?: () => Date;
  /** PBKDF2 iterations for new password hashes; tests lower it to stay fast. */
  passwordHashIterations?: number;
}

export interface IdentityService {
  /**
   * Handles sign-in, users, Groups, Roles, Projects and API keys, the SCIM endpoints and file
   * import, the internal endpoints for tokens and API key resolution, the OpenAPI document and
   * health checks.
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
  const signInRepository = createSignInRepository(dependencies.database);
  const browserSignIns = createBrowserSignIns(signInRepository, readCurrentTime);
  const oidcSettings = dependencies.oidcSettings ?? null;
  const directoryTokenRepository = createDirectoryTokenRepository(dependencies.database);

  registerInternalTokenRoutes(app, {
    projectRepository,
    accessTokenSigner,
    serviceClientSecrets: dependencies.serviceClientSecrets,
  });
  // Outside /v1/, because a directory has a token of its own instead of a user's.
  registerScimRoutes(app, {
    scimRepository: createScimRepository(dependencies.database),
    directoryTokenRepository,
    readCurrentTime,
  });
  app.use("/v1/*", requireSignedInUser(accessTokenSigner, accessRepository));
  registerSignInRoutes(app, {
    accessRepository,
    projectRepository,
    signInRepository,
    accessTokenSigner,
    browserSignIns,
    passwordAttemptThrottle: createPasswordAttemptThrottle(
      createSignInThrottleRepository(dependencies.database),
      readCurrentTime,
    ),
    areLocalAccountsEnabled: dependencies.areLocalAccountsEnabled,
    oidcProviderName: oidcSettings?.providerName ?? null,
    passwordHashIterations,
    readCurrentTime,
  });
  registerOidcSignInRoutes(app, {
    provider: oidcSettings === null
      ? null
      : createOidcProvider(oidcSettings, dependencies.fetchFromOidcProvider),
    oidcRepository: createOidcRepository(dependencies.database),
    browserSignIns,
    logger: dependencies.logger,
    readCurrentTime,
  });
  registerAccessRoutes(app, {
    accessRepository,
    projectRepository,
    areLocalAccountsEnabled: dependencies.areLocalAccountsEnabled,
    passwordHashIterations,
    readCurrentTime,
  });
  registerDirectoryRoutes(app, {
    directoryTokenRepository,
    directoryImportRepository: createDirectoryImportRepository(dependencies.database),
    readCurrentTime,
  });
  registerProjectRoutes(app, { projectRepository, accessRepository, readCurrentTime });
  return { handleRequest: (request) => app.fetch(request) };
}
