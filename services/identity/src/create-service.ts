import type { ServiceRequestHandler } from "@extispex/service-client";
import { createBackgroundLease } from "@extispex/service-storage";
import {
  createServiceHttpApp,
  DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS,
  type SecretCipher,
  type StructuredLogger,
} from "@extispex/service-runtime";
import { DEFAULT_PASSWORD_HASH_ITERATIONS } from "./accounts/mod.ts";
import { createAccessTokenSigner, registerInternalTokenRoutes } from "./access-tokens/mod.ts";
import {
  type IdentityEnvironment,
  registerAccessRoutes,
  requireSignedInUser,
} from "./access/mod.ts";
import { registerDirectoryRoutes } from "./directory/mod.ts";
import {
  createIdentityDataLifecycle,
  type IdentityDataLifecycleOutcome,
} from "./data-lifecycle/mod.ts";
import { createOidcProvider, type OidcSettings, registerOidcSignInRoutes } from "./oidc/mod.ts";
import { registerProjectLifecycleRoutes, registerProjectRoutes } from "./projects/mod.ts";
import { registerScimRoutes } from "./scim/mod.ts";
import {
  createBrowserSignIns,
  createPasswordAttemptThrottle,
  registerSignInRoutes,
} from "./sign-in/mod.ts";
import {
  createAccessRepository,
  createDirectoryImportRepository,
  createDirectoryTokenRepository,
  createOidcRepository,
  createProjectRepository,
  createScimRepository,
  createSignInRepository,
  createSignInThrottleRepository,
  type IdentityDatabase,
} from "./storage/mod.ts";

export {
  createFirstAdministratorIfNone,
  DEFAULT_FIRST_ADMINISTRATOR_EMAIL,
  type FirstAdministrator,
  parseServiceClients,
} from "./accounts/mod.ts";
export { createSigningKeyCipher, protectStoredSigningKeys } from "./access-tokens/mod.ts";
export {
  generateApiKey,
  generateRandomCharacters,
  generateServiceClientSecret,
  MINIMUM_CONFIGURED_KEY_LENGTH,
} from "./api-keys/mod.ts";
export { type OidcSettings, readOidcSettings } from "./oidc/mod.ts";
export { createFirstProjectIfNone, FIRST_PROJECT_NAME } from "./projects/mod.ts";
export { type IdentityDatabase, openIdentityDatabase } from "./storage/mod.ts";
export type { IdentityDataLifecycleOutcome } from "./data-lifecycle/mod.ts";

export interface IdentityServiceDependencies {
  database: IdentityDatabase;
  /** Protects the private signing keys in the database; from `createSigningKeyCipher`. */
  signingKeyCipher: SecretCipher;
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
  /** How often `runDataLifecycle` runs; its lease lasts two intervals. */
  dataLifecycleIntervalMilliseconds?: number;
  /** Who holds the data lifecycle's lease; one ID per process by default. */
  leaseHolder?: string;
}

export interface IdentityService {
  /**
   * Handles sign-in, users, Groups, Roles, Projects and API keys, the SCIM endpoints and file
   * import, the internal endpoints for tokens and API key resolution, the OpenAPI document and
   * health checks.
   */
  handleRequest: ServiceRequestHandler;
  /**
   * One run of the periodic data work, if this replica gets the lease: removes Identity's data of
   * deleted Projects and the personal data of users deactivated 30 days ago. `main.ts` runs it
   * every `DATA_LIFECYCLE_INTERVAL_MILLISECONDS`.
   */
  runDataLifecycle(): Promise<IdentityDataLifecycleOutcome>;
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
  const accessTokenSigner = createAccessTokenSigner(
    dependencies.database,
    dependencies.signingKeyCipher,
    readCurrentTime,
  );
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
  registerProjectLifecycleRoutes(app, { projectRepository, accessTokenSigner, readCurrentTime });
  const runDataLifecycle = createIdentityDataLifecycle({
    projectRepository,
    accessRepository,
    lease: createBackgroundLease(dependencies.database, {
      name: "data-lifecycle",
      holder: dependencies.leaseHolder ?? crypto.randomUUID(),
      durationMilliseconds: 2 *
        (dependencies.dataLifecycleIntervalMilliseconds ??
          DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS),
    }),
    logger: dependencies.logger,
    readCurrentTime,
  });
  return { handleRequest: (request) => app.fetch(request), runDataLifecycle };
}
