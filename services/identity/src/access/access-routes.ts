import {
  addGroupMemberRoute,
  assignRoleRoute,
  createErrorResponse,
  createGroupRoute,
  createUserRoute,
  deleteGroupRoute,
  getCurrentUserRoute,
  listGroupsRoute,
  listRoleAssignmentsRoute,
  listUsersRoute,
  removeGroupMemberRoute,
  removeRoleAssignmentRoute,
  setCompanyGroupsRoute,
  updateUserRoute,
} from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { hashPassword } from "../accounts/mod.ts";
import type {
  AccessRepository,
  ProjectRepository,
  StoredUser,
  UserChanges,
} from "../storage/mod.ts";
import {
  canManageProject,
  forbiddenError,
  type IdentityEnvironment,
  INSTANCE_ADMIN_REQUIRED,
  PROJECT_ADMIN_REQUIRED,
} from "./user-authentication.ts";

export interface AccessRouteDependencies {
  accessRepository: AccessRepository;
  projectRepository: ProjectRepository;
  areLocalAccountsEnabled: boolean;
  passwordHashIterations: number;
  readCurrentTime: () => Date;
}

const LOCAL_ACCOUNTS_DISABLED = forbiddenError(
  "Local accounts are disabled on this Instance, so users cannot get a password here.",
);

function userNotFoundError(userId: string) {
  return createErrorResponse("not_found", `User ${userId} was not found.`);
}

function groupNotFoundError(groupId: string) {
  return createErrorResponse("not_found", `Group ${groupId} was not found.`);
}

function projectNotFoundError(projectId: string) {
  return createErrorResponse("not_found", `Project ${projectId} was not found.`);
}

function toUser({ passwordHash: _passwordHash, ...user }: StoredUser) {
  return user;
}

/** The current user, users, Groups and Role assignments. */
export function registerAccessRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: AccessRouteDependencies,
): void {
  const { accessRepository, projectRepository } = dependencies;

  app.openapi(getCurrentUserRoute, (context) => {
    return context.json(toUser(context.get("currentUser")), 200);
  });

  app.openapi(listUsersRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    return context.json({ users: await accessRepository.listUsers() }, 200);
  });

  app.openapi(createUserRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    if (!dependencies.areLocalAccountsEnabled) return context.json(LOCAL_ACCOUNTS_DISABLED, 403);
    const { email, displayName, password, isInstanceAdmin } = context.req.valid("json");
    const creation = await accessRepository.createUser({
      email,
      displayName,
      passwordHash: await hashPassword(password, dependencies.passwordHashIterations),
      isInstanceAdmin,
    }, dependencies.readCurrentTime());
    if (creation.status === "email_taken") {
      return context.json(
        createErrorResponse("conflict", `A user with the email address ${email} already exists.`),
        409,
      );
    }
    return context.json(creation.user, 201);
  });

  app.openapi(updateUserRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { userId } = context.req.valid("param");
    const request = context.req.valid("json");
    if (request.password !== undefined && !dependencies.areLocalAccountsEnabled) {
      return context.json(LOCAL_ACCOUNTS_DISABLED, 403);
    }
    const changes: UserChanges = {
      displayName: request.displayName,
      isInstanceAdmin: request.isInstanceAdmin,
      passwordHash: request.password === undefined
        ? undefined
        : await hashPassword(request.password, dependencies.passwordHashIterations),
      deactivatedAt: request.isDeactivated === undefined
        ? undefined
        : request.isDeactivated
        ? dependencies.readCurrentTime()
        : null,
    };
    const update = await accessRepository.updateUser(userId, changes);
    if (update.status === "not_found") return context.json(userNotFoundError(userId), 404);
    if (update.status === "last_instance_admin") {
      return context.json(
        createErrorResponse(
          "conflict",
          "The Instance needs at least one active Instance admin. Make someone else one first.",
        ),
        409,
      );
    }
    if (update.status === "personal_data_deleted") {
      return context.json(
        createErrorResponse(
          "conflict",
          "This user's personal data was deleted 30 days after deactivation, so the user cannot " +
            "be changed. Create a new user instead.",
        ),
        409,
      );
    }
    return context.json(update.user, 200);
  });

  app.openapi(listGroupsRoute, async (context) => {
    return context.json({ groups: await accessRepository.listGroups() }, 200);
  });

  app.openapi(createGroupRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { name } = context.req.valid("json");
    const creation = await accessRepository.createGroup(name, dependencies.readCurrentTime());
    if (creation.status === "name_taken") {
      return context.json(
        createErrorResponse("conflict", `A Group named ${name} already exists.`),
        409,
      );
    }
    return context.json(creation.group, 201);
  });

  app.openapi(deleteGroupRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { groupId } = context.req.valid("param");
    if (!await accessRepository.deleteGroup(groupId)) {
      return context.json(groupNotFoundError(groupId), 404);
    }
    return context.body(null, 204);
  });

  app.openapi(addGroupMemberRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { groupId, userId } = context.req.valid("param");
    const addition = await accessRepository.addGroupMember(
      groupId,
      userId,
      dependencies.readCurrentTime(),
    );
    if (addition.status === "group_not_found") {
      return context.json(groupNotFoundError(groupId), 404);
    }
    if (addition.status === "user_not_found") return context.json(userNotFoundError(userId), 404);
    return context.json(addition.group, 200);
  });

  app.openapi(removeGroupMemberRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { groupId, userId } = context.req.valid("param");
    const group = await accessRepository.removeGroupMember(groupId, userId);
    if (group === null) return context.json(groupNotFoundError(groupId), 404);
    return context.json(group, 200);
  });

  app.openapi(setCompanyGroupsRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { groupId } = context.req.valid("param");
    const { companyGroups } = context.req.valid("json");
    const group = await accessRepository.setCompanyGroups(
      groupId,
      companyGroups,
      dependencies.readCurrentTime(),
    );
    if (group === null) return context.json(groupNotFoundError(groupId), 404);
    return context.json(group, 200);
  });

  app.openapi(listRoleAssignmentsRoute, async (context) => {
    const { projectId } = context.req.valid("param");
    if (await projectRepository.findProject(projectId) === null) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    if (!await canManageProject(accessRepository, context.get("currentUser"), projectId)) {
      return context.json(PROJECT_ADMIN_REQUIRED, 403);
    }
    return context.json(
      { roleAssignments: await accessRepository.listRoleAssignments(projectId) },
      200,
    );
  });

  app.openapi(assignRoleRoute, async (context) => {
    const { projectId, groupId } = context.req.valid("param");
    const { role } = context.req.valid("json");
    if (await projectRepository.findProject(projectId) === null) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    if (!await canManageProject(accessRepository, context.get("currentUser"), projectId)) {
      return context.json(PROJECT_ADMIN_REQUIRED, 403);
    }
    const assignment = await accessRepository.assignRole(
      projectId,
      groupId,
      role,
      dependencies.readCurrentTime(),
    );
    if (assignment.status === "group_not_found") {
      return context.json(groupNotFoundError(groupId), 404);
    }
    return context.json(assignment.roleAssignment, 200);
  });

  app.openapi(removeRoleAssignmentRoute, async (context) => {
    const { projectId, groupId } = context.req.valid("param");
    if (await projectRepository.findProject(projectId) === null) {
      return context.json(projectNotFoundError(projectId), 404);
    }
    if (!await canManageProject(accessRepository, context.get("currentUser"), projectId)) {
      return context.json(PROJECT_ADMIN_REQUIRED, 403);
    }
    await accessRepository.removeRoleAssignment(projectId, groupId);
    return context.body(null, 204);
  });
}
