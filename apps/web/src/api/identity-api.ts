import type {
  AccessibleProject,
  CreatedApiKey,
  CreateUserRequest,
  Group,
  ListApiKeysResponse,
  ListGroupsResponse,
  ListProjectsResponse,
  ListRoleAssignmentsResponse,
  ListUsersResponse,
  Project,
  Role,
  RoleAssignment,
  UpdateUserRequest,
  User,
} from "@extispex/contracts";
import { type ApiCredentials, requestJson } from "./api-request.ts";

/** Every call here takes a user's access token; Identity checks the user's rights itself. */

function projectPath(projectId: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}`;
}

function groupPath(groupId: string): string {
  return `/v1/groups/${encodeURIComponent(groupId)}`;
}

export function getCurrentUser(credentials: ApiCredentials): Promise<User> {
  return requestJson(credentials, "/v1/me");
}

export function listProjects(credentials: ApiCredentials): Promise<ListProjectsResponse> {
  return requestJson(credentials, "/v1/projects");
}

export function createProject(credentials: ApiCredentials, name: string): Promise<Project> {
  return requestJson(credentials, "/v1/projects", { method: "POST", body: { name } });
}

export function getProject(
  credentials: ApiCredentials,
  projectId: string,
): Promise<AccessibleProject> {
  return requestJson(credentials, projectPath(projectId));
}

export function deleteProject(credentials: ApiCredentials, projectId: string): Promise<null> {
  return requestJson(credentials, projectPath(projectId), { method: "DELETE" });
}

export function listApiKeys(
  credentials: ApiCredentials,
  projectId: string,
): Promise<ListApiKeysResponse> {
  return requestJson(credentials, `${projectPath(projectId)}/api-keys`);
}

export function createApiKey(
  credentials: ApiCredentials,
  projectId: string,
  name: string,
): Promise<CreatedApiKey> {
  return requestJson(credentials, `${projectPath(projectId)}/api-keys`, {
    method: "POST",
    body: { name },
  });
}

export function revokeApiKey(
  credentials: ApiCredentials,
  projectId: string,
  apiKeyId: string,
): Promise<null> {
  return requestJson(
    credentials,
    `${projectPath(projectId)}/api-keys/${encodeURIComponent(apiKeyId)}`,
    { method: "DELETE" },
  );
}

export function listRoleAssignments(
  credentials: ApiCredentials,
  projectId: string,
): Promise<ListRoleAssignmentsResponse> {
  return requestJson(credentials, `${projectPath(projectId)}/role-assignments`);
}

export function assignRole(
  credentials: ApiCredentials,
  projectId: string,
  groupId: string,
  role: Role,
): Promise<RoleAssignment> {
  return requestJson(
    credentials,
    `${projectPath(projectId)}/role-assignments/${encodeURIComponent(groupId)}`,
    { method: "PUT", body: { role } },
  );
}

export function removeRoleAssignment(
  credentials: ApiCredentials,
  projectId: string,
  groupId: string,
): Promise<null> {
  return requestJson(
    credentials,
    `${projectPath(projectId)}/role-assignments/${encodeURIComponent(groupId)}`,
    { method: "DELETE" },
  );
}

export function listUsers(credentials: ApiCredentials): Promise<ListUsersResponse> {
  return requestJson(credentials, "/v1/users");
}

export function createUser(credentials: ApiCredentials, request: CreateUserRequest): Promise<User> {
  return requestJson(credentials, "/v1/users", { method: "POST", body: request });
}

export function updateUser(
  credentials: ApiCredentials,
  userId: string,
  request: UpdateUserRequest,
): Promise<User> {
  return requestJson(credentials, `/v1/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: request,
  });
}

export function listGroups(credentials: ApiCredentials): Promise<ListGroupsResponse> {
  return requestJson(credentials, "/v1/groups");
}

export function createGroup(credentials: ApiCredentials, name: string): Promise<Group> {
  return requestJson(credentials, "/v1/groups", { method: "POST", body: { name } });
}

export function deleteGroup(credentials: ApiCredentials, groupId: string): Promise<null> {
  return requestJson(credentials, groupPath(groupId), { method: "DELETE" });
}

export function addGroupMember(
  credentials: ApiCredentials,
  groupId: string,
  userId: string,
): Promise<Group> {
  return requestJson(credentials, `${groupPath(groupId)}/members/${encodeURIComponent(userId)}`, {
    method: "PUT",
  });
}

export function removeGroupMember(
  credentials: ApiCredentials,
  groupId: string,
  userId: string,
): Promise<Group> {
  return requestJson(credentials, `${groupPath(groupId)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}
