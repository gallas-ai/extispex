import type { ServiceRequestHandler } from "@extispex/service-client";
import { createServiceHttpApp, type StructuredLogger } from "@extispex/service-runtime";
import { registerApiKeyResolutionRoute, registerProjectRoutes } from "./projects/project-routes.ts";
import type { IdentityDatabase } from "./storage/identity-database.ts";
import { createProjectRepository } from "./storage/project-repository.ts";

export {
  generateApiKey,
  generateInstanceAdminKey,
  MINIMUM_CONFIGURED_KEY_LENGTH,
} from "./api-keys/api-key-secrets.ts";
export { createFirstProjectIfNone, FIRST_PROJECT_NAME } from "./projects/first-project.ts";
export { type IdentityDatabase, openIdentityDatabase } from "./storage/identity-database.ts";

export interface IdentityServiceDependencies {
  database: IdentityDatabase;
  /** Authorizes managing Projects and API keys until users and Roles exist. */
  instanceAdminKey: string;
  logger: StructuredLogger;
  readCurrentTime?: () => Date;
}

export interface IdentityService {
  /**
   * Handles Project and API key management, the internal API key resolution, the OpenAPI document
   * and health checks.
   */
  handleRequest: ServiceRequestHandler;
}

export function createIdentityService(dependencies: IdentityServiceDependencies): IdentityService {
  const app = createServiceHttpApp({
    apiTitle: "Extispex: Identity API",
    logger: dependencies.logger,
  });
  const projectRepository = createProjectRepository(dependencies.database);
  registerApiKeyResolutionRoute(app, { projectRepository });
  registerProjectRoutes(app, {
    projectRepository,
    instanceAdminKey: dependencies.instanceAdminKey,
    readCurrentTime: dependencies.readCurrentTime ?? (() => new Date()),
  });
  return { handleRequest: (request) => app.fetch(request) };
}
