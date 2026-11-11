import {
  createApiKeyRoute,
  createErrorResponse,
  createProjectRoute,
  deleteProjectRoute,
  getProjectRoute,
  listApiKeysRoute,
  listDeletedProjectsRoute,
  listProjectsRoute,
  revokeApiKeyRoute,
  updateProjectRoute,
} from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  canManageProject,
  type IdentityEnvironment,
  INSTANCE_ADMIN_REQUIRED,
  PROJECT_ADMIN_REQUIRED,
} from "../access/mod.ts";
import { ACCESS_TOKEN_LIFETIME_SECONDS } from "../access-tokens/mod.ts";
import { generateApiKey, hashApiKey, readKeyPrefix } from "../api-keys/mod.ts";
import type { AccessRepository, ProjectRepository } from "../storage/mod.ts";

export interface ProjectRouteDependencies {
  projectRepository: ProjectRepository;
  accessRepository: AccessRepository;
  readCurrentTime: () => Date;
}

function projectNotFoundError(projectId: string) {
  return createErrorResponse("not_found", `Project ${projectId} was not found.`);
}

/**
 * Projects and their API keys. Users see the Projects they have a Role in; Instance admins see
 * every Project and create and delete them. A Project's `admin` manages its API keys.
 */
export function registerProjectRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: ProjectRouteDependencies,
): void {
  const { projectRepository, accessRepository } = dependencies;

  app.openapi(createProjectRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
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
    const currentUser = context.get("currentUser");
    const rolesByProject = await accessRepository.listUserRoles(currentUser.id);
    const projects = (await projectRepository.listProjects())
      .map((project) => ({ ...project, role: rolesByProject.get(project.id) ?? null }))
      .filter((project) => currentUser.isInstanceAdmin || project.role !== null);
    return context.json({ projects }, 200);
  });

  app.openapi(getProjectRoute, async (context) => {
    const { projectId } = context.req.valid("param");
    const currentUser = context.get("currentUser");
    const project = await projectRepository.findProject(projectId);
    const role = await accessRepository.findUserRole(currentUser.id, projectId);
    // Users without a Role cannot tell a Project they may not see from one that does not exist.
    if (project === null || (role === null && !currentUser.isInstanceAdmin)) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    return context.json({ ...project, role }, 200);
  });

  app.openapi(updateProjectRoute, async (context) => {
    const { projectId } = context.req.valid("param");
    const { retentionDays } = context.req.valid("json");
    const currentUser = context.get("currentUser");
    const project = await projectRepository.findProject(projectId);
    const role = await accessRepository.findUserRole(currentUser.id, projectId);
    if (project === null || (role === null && !currentUser.isInstanceAdmin)) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    if (!currentUser.isInstanceAdmin && role !== "admin") {
      return context.json(PROJECT_ADMIN_REQUIRED, 403);
    }
    const changedProject = retentionDays === undefined
      ? project
      : await projectRepository.setRetentionDays(projectId, retentionDays);
    if (changedProject === null) return context.json(projectNotFoundError(projectId), 404);
    return context.json({ ...changedProject, role }, 200);
  });

  app.openapi(listDeletedProjectsRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { limit } = context.req.valid("query");
    const deletedProjects = await projectRepository.listDeletedProjects(
      limit,
      ACCESS_TOKEN_LIFETIME_SECONDS * 1000,
    );
    return context.json({ deletedProjects }, 200);
  });

  app.openapi(deleteProjectRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
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
    if (!await canManageProject(accessRepository, context.get("currentUser"), projectId)) {
      return context.json(PROJECT_ADMIN_REQUIRED, 403);
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
    if (!await canManageProject(accessRepository, context.get("currentUser"), projectId)) {
      return context.json(PROJECT_ADMIN_REQUIRED, 403);
    }
    return context.json({ apiKeys: await projectRepository.listApiKeys(projectId) }, 200);
  });

  app.openapi(revokeApiKeyRoute, async (context) => {
    const { projectId, apiKeyId } = context.req.valid("param");
    if (await projectRepository.findProject(projectId) === null) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    if (!await canManageProject(accessRepository, context.get("currentUser"), projectId)) {
      return context.json(PROJECT_ADMIN_REQUIRED, 403);
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
