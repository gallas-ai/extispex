import {
  createErrorResponse,
  PROJECT_DATA_SERVICES,
  readProjectLifecycleRoute,
  recordProjectDataRemovalRoute,
} from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { authenticateService, type IdentityEnvironment } from "../access/mod.ts";
import { ACCESS_TOKEN_LIFETIME_SECONDS, type AccessTokenSigner } from "../access-tokens/mod.ts";
import type { ProjectRepository } from "../storage/mod.ts";

export interface ProjectLifecycleRouteDependencies {
  projectRepository: ProjectRepository;
  accessTokenSigner: AccessTokenSigner;
  readCurrentTime: () => Date;
}

const SERVICE_TOKEN_REQUIRED = createErrorResponse(
  "unauthenticated",
  "A service token is required.",
);

/**
 * The internal endpoints of the services' periodic data work: Retention Periods, the deleted
 * Projects each service still has to remove, and each service's report that it has. The service
 * token's client ID says which service asks.
 */
export function registerProjectLifecycleRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: ProjectLifecycleRouteDependencies,
): void {
  const { projectRepository, accessTokenSigner } = dependencies;

  app.openapi(readProjectLifecycleRoute, async (context) => {
    const service = await authenticateService(
      accessTokenSigner,
      context.req.header("authorization"),
    );
    if (service === null) return context.json(SERVICE_TOKEN_REQUIRED, 401);
    return context.json(
      await projectRepository.readProjectLifecycle(service, ACCESS_TOKEN_LIFETIME_SECONDS * 1000),
      200,
    );
  });

  app.openapi(recordProjectDataRemovalRoute, async (context) => {
    const service = await authenticateService(
      accessTokenSigner,
      context.req.header("authorization"),
    );
    if (service === null) return context.json(SERVICE_TOKEN_REQUIRED, 401);
    if (!(PROJECT_DATA_SERVICES as readonly string[]).includes(service)) {
      return context.json(
        createErrorResponse("forbidden", `The service ${service} keeps no Project data.`),
        403,
      );
    }
    const { projectId } = context.req.valid("param");
    const isRecorded = await projectRepository.recordDataRemoval(
      projectId,
      service,
      dependencies.readCurrentTime(),
    );
    if (!isRecorded) {
      return context.json(
        createErrorResponse("not_found", `No deleted Project has the ID ${projectId}.`),
        404,
      );
    }
    return context.body(null, 204);
  });
}
