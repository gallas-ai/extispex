import type {
  CreatedApiKey,
  ListApiKeysResponse,
  ListProjectsResponse,
  Project,
} from "@extispex/contracts";
import { requestJson } from "./api-request.ts";

/** Every call here takes the Instance admin key, not a Project API key. */

function projectPath(projectId: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}`;
}

export function listProjects(instanceAdminKey: string): Promise<ListProjectsResponse> {
  return requestJson(instanceAdminKey, "/v1/projects");
}

export function createProject(instanceAdminKey: string, name: string): Promise<Project> {
  return requestJson(instanceAdminKey, "/v1/projects", { method: "POST", body: { name } });
}

export function getProject(instanceAdminKey: string, projectId: string): Promise<Project> {
  return requestJson(instanceAdminKey, projectPath(projectId));
}

export function deleteProject(instanceAdminKey: string, projectId: string): Promise<null> {
  return requestJson(instanceAdminKey, projectPath(projectId), { method: "DELETE" });
}

export function listApiKeys(
  instanceAdminKey: string,
  projectId: string,
): Promise<ListApiKeysResponse> {
  return requestJson(instanceAdminKey, `${projectPath(projectId)}/api-keys`);
}

export function createApiKey(
  instanceAdminKey: string,
  projectId: string,
  name: string,
): Promise<CreatedApiKey> {
  return requestJson(instanceAdminKey, `${projectPath(projectId)}/api-keys`, {
    method: "POST",
    body: { name },
  });
}

export function revokeApiKey(
  instanceAdminKey: string,
  projectId: string,
  apiKeyId: string,
): Promise<null> {
  return requestJson(
    instanceAdminKey,
    `${projectPath(projectId)}/api-keys/${encodeURIComponent(apiKeyId)}`,
    { method: "DELETE" },
  );
}
