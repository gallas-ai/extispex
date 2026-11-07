import {
  createApiKeyRoute,
  createErrorResponse,
  createProjectRoute,
  deleteProjectRoute,
  getProjectRoute,
  listApiKeysRoute,
  listProjectsRoute,
  resolveApiKeyRoute,
  revokeApiKeyRoute,
} from "@extispex/contracts";
import { extractBearerToken } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  areSecretsEqual,
  generateApiKey,
  hashApiKey,
  readKeyPrefix,
} from "../api-keys/api-key-secrets.ts";
import type { ProjectRepository } from "../storage/project-repository.ts";

export interface ProjectRouteDependencies {
  projectRepository: ProjectRepository;
  instanceAdminKey: string;
  readCurrentTime: () => Date;
}

const unauthenticatedError = createErrorResponse(
  "unauthenticated",
  "The Instance admin key is required in the Authorization header as a Bearer token.",
);

function projectNotFoundError(projectId: string) {
  return createErrorResponse("not_found", `Project ${projectId} was not found.`);
}

export function registerProjectRoutes(
  app: OpenAPIHono,
  dependencies: ProjectRouteDependencies,
): void {
  const { projectRepository } = dependencies;

  app.use("/v1/*", async (context, next) => {
    const presentedKey = extractBearerToken(context.req.header("authorization"));
    if (
      presentedKey === null ||
      !await areSecretsEqual(presentedKey, dependencies.instanceAdminKey)
    ) {
      return context.json(unauthenticatedError, 401);
    }
    await next();
  });

  app.openapi(createProjectRoute, async (context) => {
    const { name } = context.req.valid("json");
    const creation = await projectRepository.createProject(name, dependencies.readCurrentTime());
    if (creation.status === "name_taken") {
      return context.json(
        createErrorResponse("conflict", `A Project named ${name} already exists.`),
        409,
      );
    }
    return context.json(creation.project, 201);
  });

  app.openapi(listProjectsRoute, async (context) => {
    return context.json({ projects: await projectRepository.listProjects() }, 200);
  });

  app.openapi(getProjectRoute, async (context) => {
    const { projectId } = context.req.valid("param");
    const project = await projectRepository.findProject(projectId);
    if (project === null) return context.json(projectNotFoundError(projectId), 404);
    return context.json(project, 200);
  });

  app.openapi(deleteProjectRoute, async (context) => {
    const { projectId } = context.req.valid("param");
    if (!await projectRepository.deleteProject(projectId, dependencies.readCurrentTime())) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    return context.body(null, 204);
  });

  app.openapi(createApiKeyRoute, async (context) => {
    const { projectId } = context.req.valid("param");
    const { name } = context.req.valid("json");
    if (await projectRepository.findProject(projectId) === null) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    const apiKey = generateApiKey();
    const storedApiKey = await projectRepository.createApiKey(
      projectId,
      { name, keyPrefix: readKeyPrefix(apiKey), keyHash: await hashApiKey(apiKey) },
      dependencies.readCurrentTime(),
    );
    return context.json({ ...storedApiKey, apiKey }, 201);
  });

  app.openapi(listApiKeysRoute, async (context) => {
    const { projectId } = context.req.valid("param");
    if (await projectRepository.findProject(projectId) === null) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    return context.json({ apiKeys: await projectRepository.listApiKeys(projectId) }, 200);
  });

  app.openapi(revokeApiKeyRoute, async (context) => {
    const { projectId, apiKeyId } = context.req.valid("param");
    if (await projectRepository.findProject(projectId) === null) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    const revocation = await projectRepository.revokeApiKey(
      projectId,
      apiKeyId,
      dependencies.readCurrentTime(),
    );
    if (revocation === "not_found") {
      return context.json(
        createErrorResponse("not_found", `Project ${projectId} has no API key ${apiKeyId}.`),
        404,
      );
    }
    return context.body(null, 204);
  });
}

/** Lets Telemetry and Prompt find the Project of an API key; not reachable through the Gateway. */
export function registerApiKeyResolutionRoute(
  app: OpenAPIHono,
  dependencies: Pick<ProjectRouteDependencies, "projectRepository">,
): void {
  app.openapi(resolveApiKeyRoute, async (context) => {
    const { apiKey } = context.req.valid("json");
    const projectId = await dependencies.projectRepository.findProjectIdByKeyHash(
      await hashApiKey(apiKey),
    );
    if (projectId === null) {
      return context.json(createErrorResponse("not_found", "The API key does not work."), 404);
    }
    return context.json({ projectId }, 200);
  });
}
