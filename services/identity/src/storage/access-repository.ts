import {
  type Group,
  pickHigherRole,
  type Role,
  type RoleAssignment,
  type User,
} from "@extispex/contracts";
import {
  type EntityManager,
  type InferEntity,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import { isLastActiveInstanceAdmin, reconcileGroupMemberships } from "./directory-memberships.ts";
import type { IdentityDatabase } from "./identity-database.ts";
import {
  CompanyGroupMappingRecord,
  CompanyGroupMemberRecord,
  CompanyGroupRecord,
  GroupMemberRecord,
  GroupRecord,
  ProjectRecord,
  RoleAssignmentRecord,
  SignInRecord,
  UserRecord,
} from "./identity-entities.ts";
import { generateTimeOrderedId } from "./time-ordered-id.ts";

type UserRow = InferEntity<typeof UserRecord>;
type GroupRow = InferEntity<typeof GroupRecord>;

/** A user as stored, with the password hash that the API never returns. */
export interface StoredUser extends User {
  passwordHash: string | null;
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash: string | null;
  isInstanceAdmin: boolean;
}

export interface UserChanges {
  displayName?: string;
  passwordHash?: string;
  isInstanceAdmin?: boolean;
  /** A date deactivates the user, null reactivates them. */
  deactivatedAt?: Date | null;
}

export type CreateUserResult = { status: "created"; user: User } | { status: "email_taken" };
export type UpdateUserResult =
  | { status: "updated"; user: User }
  | { status: "not_found" }
  | { status: "last_instance_admin" }
  | { status: "personal_data_deleted" };
export type CreateGroupResult = { status: "created"; group: Group } | { status: "name_taken" };
export type AddGroupMemberResult =
  | { status: "added"; group: Group }
  | { status: "group_not_found" }
  | { status: "user_not_found" };
export type AssignRoleResult =
  | { status: "assigned"; roleAssignment: RoleAssignment }
  | { status: "group_not_found" };

/** What a user whose personal data is deleted is called. */
export const DELETED_USER_DISPLAY_NAME = "Deleted user";

/**
 * The email of a user whose personal data is deleted: unique, because emails are, and never
 * deliverable, because `.invalid` is reserved for that (RFC 2606).
 */
function formatDeletedUserEmail(userId: string): string {
  return `deleted-user-${userId}@deleted.invalid`;
}

/** The first administrator's Group, which gets the Role `admin` in every Project at first start. */
export const FIRST_ADMINISTRATORS_GROUP_NAME = "Administrators";

/** Users, Groups, their members, and Groups' Roles in Projects. */
export interface AccessRepository {
  createUser(newUser: NewUser, createdAt: Date): Promise<CreateUserResult>;
  /**
   * Creates the first user, an Instance admin, in a Group that gets the Role `admin` in every
   * Project, only while the Instance has no user. Resolves to null when there already was one.
   */
  createFirstAdministrator(newUser: NewUser, createdAt: Date): Promise<User | null>;
  /** By email. */
  listUsers(): Promise<User[]>;
  findUser(userId: string): Promise<StoredUser | null>;
  findUserByEmail(email: string): Promise<StoredUser | null>;
  /**
   * Applies the changes, refusing any that would leave the Instance without an active Instance
   * admin. Deactivating a user ends their sign-ins.
   */
  updateUser(userId: string, changes: UserChanges): Promise<UpdateUserResult>;
  /**
   * Deletes for good the email, name and sign-in identities of users deactivated before `cutoff`,
   * with their memberships and sign-ins. The row stays with its ID, as "Deleted user", so that
   * what refers to it still resolves. Resolves to how many users it changed.
   */
  deletePersonalDataOfUsersDeactivatedBefore(cutoff: Date, now: Date): Promise<number>;

  createGroup(name: string, createdAt: Date): Promise<CreateGroupResult>;
  /** By name, each with its members by email. */
  listGroups(): Promise<Group[]>;
  /** Deletes the Group with its memberships and Role assignments. False for an unknown Group. */
  deleteGroup(groupId: string): Promise<boolean>;
  addGroupMember(groupId: string, userId: string, addedAt: Date): Promise<AddGroupMemberResult>;
  /** Null for an unknown Group; removing a user who is not a member changes nothing. */
  removeGroupMember(groupId: string, userId: string): Promise<Group | null>;
  /**
   * Replaces the Group's Company groups, and moves people whom the directory lists in the ones
   * added or removed in or out of the Group at once. Null for an unknown Group.
   */
  setCompanyGroups(
    groupId: string,
    companyGroupNames: string[],
    now: Date,
  ): Promise<Group | null>;

  /** By Group name. */
  listRoleAssignments(projectId: string): Promise<RoleAssignment[]>;
  /** Gives the Group the Role in the Project, replacing the Role it had there. */
  assignRole(
    projectId: string,
    groupId: string,
    role: Role,
    assignedAt: Date,
  ): Promise<AssignRoleResult>;
  removeRoleAssignment(projectId: string, groupId: string): Promise<void>;
  /** The highest Role the user gets in the Project through their Groups, or null. */
  findUserRole(userId: string, projectId: string): Promise<Role | null>;
  /** The highest Role in each Project where the user has one. */
  listUserRoles(userId: string): Promise<Map<string, Role>>;
}

export function createAccessRepository(database: IdentityDatabase): AccessRepository {
  const listGroupsWhere = async (
    entityManager: EntityManager,
    groupFilter: { id?: string },
  ): Promise<Group[]> => {
    const groupRows = await entityManager.find(GroupRecord, groupFilter, {
      orderBy: { name: "asc" },
    });
    if (groupRows.length === 0) return [];
    const memberRows = await entityManager.find(GroupMemberRecord, {
      groupId: { $in: groupRows.map((groupRow) => groupRow.id) },
    });
    const memberUsers = memberRows.length === 0 ? [] : await entityManager.find(UserRecord, {
      id: { $in: [...new Set(memberRows.map((memberRow) => memberRow.userId))] },
    }, { orderBy: { email: "asc" } });
    const mappingRows = await entityManager.find(CompanyGroupMappingRecord, {
      groupId: { $in: groupRows.map((groupRow) => groupRow.id) },
    }, { orderBy: { companyGroupName: "asc" } });
    return groupRows.map((groupRow) => toGroup(groupRow, memberRows, memberUsers, mappingRows));
  };

  const findGroupWith = async (entityManager: EntityManager, groupId: string) =>
    (await listGroupsWhere(entityManager, { id: groupId }))[0] ?? null;

  const listUserGroupIds = async (entityManager: EntityManager, userId: string) =>
    (await entityManager.find(GroupMemberRecord, { userId })).map((memberRow) => memberRow.groupId);

  return {
    async createUser(newUser, createdAt) {
      const userRow = createUserRow(newUser, createdAt);
      try {
        await database.orm.em.fork().insert(UserRecord, userRow);
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) return { status: "email_taken" };
        throw error;
      }
      return { status: "created", user: toUser(userRow) };
    },

    async createFirstAdministrator(newUser, createdAt) {
      const userRow = createUserRow({ ...newUser, isInstanceAdmin: true }, createdAt);
      try {
        return await database.orm.em.fork().transactional(async (entityManager) => {
          if (await entityManager.count(UserRecord, {}) > 0) return null;
          await entityManager.insert(UserRecord, userRow);
          const groupId = generateTimeOrderedId(createdAt);
          await entityManager.insert(GroupRecord, {
            id: groupId,
            name: FIRST_ADMINISTRATORS_GROUP_NAME,
            createdAt,
          });
          await entityManager.insert(GroupMemberRecord, {
            groupId,
            userId: userRow.id,
            addedAt: createdAt,
            isFromCompanyGroup: false,
          });
          const projectRows = await entityManager.find(ProjectRecord, { deletedAt: null });
          for (const projectRow of projectRows) {
            await entityManager.insert(RoleAssignmentRecord, {
              projectId: projectRow.id,
              groupId,
              role: "admin",
              assignedAt: createdAt,
            });
          }
          return toUser(userRow);
        });
      } catch (error) {
        // Another replica created the first user, or the Group, between the count and the insert.
        if (error instanceof UniqueConstraintViolationException) return null;
        throw error;
      }
    },

    async listUsers() {
      const userRows = await database.orm.em.fork().find(UserRecord, {}, {
        orderBy: { email: "asc" },
      });
      return userRows.map(toUser);
    },

    async findUser(userId) {
      const userRow = await database.orm.em.fork().findOne(UserRecord, { id: userId });
      return userRow === null ? null : toStoredUser(userRow);
    },

    async findUserByEmail(email) {
      const userRow = await database.orm.em.fork().findOne(UserRecord, { email });
      return userRow === null ? null : toStoredUser(userRow);
    },

    async updateUser(userId, changes) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const userRow = await entityManager.findOne(UserRecord, { id: userId });
        if (userRow === null) return { status: "not_found" } as const;
        if (userRow.personalDataDeletedAt) return { status: "personal_data_deleted" } as const;
        const isActiveAdminNow = userRow.isInstanceAdmin && userRow.deactivatedAt === null;
        const isActiveAdminAfter = (changes.isInstanceAdmin ?? userRow.isInstanceAdmin) &&
          (changes.deactivatedAt === undefined
            ? userRow.deactivatedAt === null
            : changes.deactivatedAt === null);
        if (
          isActiveAdminNow && !isActiveAdminAfter &&
          await isLastActiveInstanceAdmin(entityManager, userRow)
        ) {
          return { status: "last_instance_admin" } as const;
        }
        const changedFields: Partial<UserRow> = {};
        if (changes.displayName !== undefined) changedFields.displayName = changes.displayName;
        if (changes.passwordHash !== undefined) changedFields.passwordHash = changes.passwordHash;
        if (changes.isInstanceAdmin !== undefined) {
          changedFields.isInstanceAdmin = changes.isInstanceAdmin;
        }
        if (changes.deactivatedAt !== undefined) {
          // Deactivating again keeps the original date.
          changedFields.deactivatedAt = changes.deactivatedAt === null
            ? null
            : userRow.deactivatedAt ?? changes.deactivatedAt;
        }
        if (Object.keys(changedFields).length > 0) {
          await entityManager.nativeUpdate(UserRecord, { id: userId }, changedFields);
        }
        if (changes.deactivatedAt) {
          await entityManager.nativeDelete(SignInRecord, { userId });
        }
        return { status: "updated", user: toUser({ ...userRow, ...changedFields }) } as const;
      });
    },

    async deletePersonalDataOfUsersDeactivatedBefore(cutoff, now) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const userRows = await entityManager.find(
          UserRecord,
          { deactivatedAt: { $ne: null, $lt: cutoff }, personalDataDeletedAt: null },
          { fields: ["id", "directoryRemovedAt"] },
        );
        for (const userRow of userRows) {
          await entityManager.nativeUpdate(UserRecord, { id: userRow.id }, {
            email: formatDeletedUserEmail(userRow.id),
            displayName: DELETED_USER_DISPLAY_NAME,
            passwordHash: null,
            oidcIssuer: null,
            oidcSubject: null,
            directoryUserName: null,
            directoryExternalId: null,
            // Hidden from SCIM, so that the directory creates a new user if the person returns.
            directoryRemovedAt: userRow.directoryRemovedAt ?? now,
            isInstanceAdmin: false,
            personalDataDeletedAt: now,
          });
        }
        const userIds = userRows.map((userRow) => userRow.id);
        if (userIds.length > 0) {
          await entityManager.nativeDelete(GroupMemberRecord, { userId: { $in: userIds } });
          await entityManager.nativeDelete(CompanyGroupMemberRecord, { userId: { $in: userIds } });
          await entityManager.nativeDelete(SignInRecord, { userId: { $in: userIds } });
        }
        return userIds.length;
      });
    },

    async createGroup(name, createdAt) {
      const groupRow = { id: generateTimeOrderedId(createdAt), name, createdAt };
      try {
        await database.orm.em.fork().insert(GroupRecord, groupRow);
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) return { status: "name_taken" };
        throw error;
      }
      return { status: "created", group: toGroup(groupRow, [], [], []) };
    },

    async listGroups() {
      return await listGroupsWhere(database.orm.em.fork(), {});
    },

    async deleteGroup(groupId) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        await entityManager.nativeDelete(GroupMemberRecord, { groupId });
        await entityManager.nativeDelete(CompanyGroupMappingRecord, { groupId });
        await entityManager.nativeDelete(RoleAssignmentRecord, { groupId });
        return await entityManager.nativeDelete(GroupRecord, { id: groupId }) > 0;
      });
    },

    async addGroupMember(groupId, userId, addedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        if (await entityManager.count(GroupRecord, { id: groupId }) === 0) {
          return { status: "group_not_found" } as const;
        }
        if (await entityManager.count(UserRecord, { id: userId }) === 0) {
          return { status: "user_not_found" } as const;
        }
        if (await entityManager.count(GroupMemberRecord, { groupId, userId }) === 0) {
          await entityManager.insert(GroupMemberRecord, {
            groupId,
            userId,
            addedAt,
            isFromCompanyGroup: false,
          });
        }
        return { status: "added", group: (await findGroupWith(entityManager, groupId))! } as const;
      });
    },

    async removeGroupMember(groupId, userId) {
      const entityManager = database.orm.em.fork();
      await entityManager.nativeDelete(GroupMemberRecord, { groupId, userId });
      return await findGroupWith(entityManager, groupId);
    },

    async setCompanyGroups(groupId, companyGroupNames, now) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        if (await entityManager.count(GroupRecord, { id: groupId }) === 0) return null;
        const oldMappingRows = await entityManager.find(CompanyGroupMappingRecord, { groupId });
        const oldNames = new Set(oldMappingRows.map((mappingRow) => mappingRow.companyGroupName));
        const newNames = new Set(companyGroupNames);
        await entityManager.nativeDelete(CompanyGroupMappingRecord, { groupId });
        for (const companyGroupName of newNames) {
          await entityManager.insert(CompanyGroupMappingRecord, { companyGroupName, groupId });
        }
        const changedNames = [
          ...[...oldNames].filter((name) => !newNames.has(name)),
          ...[...newNames].filter((name) => !oldNames.has(name)),
        ];
        await reconcileMembersOfCompanyGroups(entityManager, groupId, changedNames, now);
        return await findGroupWith(entityManager, groupId);
      });
    },

    async listRoleAssignments(projectId) {
      const entityManager = database.orm.em.fork();
      const assignmentRows = await entityManager.find(RoleAssignmentRecord, { projectId });
      if (assignmentRows.length === 0) return [];
      const groupRows = await entityManager.find(GroupRecord, {
        id: { $in: assignmentRows.map((assignmentRow) => assignmentRow.groupId) },
      });
      const groupNames = new Map(groupRows.map((groupRow) => [groupRow.id, groupRow.name]));
      return assignmentRows
        .map((assignmentRow) => ({
          groupId: assignmentRow.groupId,
          groupName: groupNames.get(assignmentRow.groupId) ?? "",
          role: assignmentRow.role as Role,
          assignedAt: assignmentRow.assignedAt.toISOString(),
        }))
        .sort((first, second) => first.groupName.localeCompare(second.groupName));
    },

    async assignRole(projectId, groupId, role, assignedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const groupRow = await entityManager.findOne(GroupRecord, { id: groupId });
        if (groupRow === null) return { status: "group_not_found" } as const;
        const updatedCount = await entityManager.nativeUpdate(
          RoleAssignmentRecord,
          { projectId, groupId },
          { role, assignedAt },
        );
        if (updatedCount === 0) {
          await entityManager.insert(RoleAssignmentRecord, {
            projectId,
            groupId,
            role,
            assignedAt,
          });
        }
        return {
          status: "assigned",
          roleAssignment: {
            groupId,
            groupName: groupRow.name,
            role,
            assignedAt: assignedAt.toISOString(),
          },
        } as const;
      });
    },

    async removeRoleAssignment(projectId, groupId) {
      await database.orm.em.fork().nativeDelete(RoleAssignmentRecord, { projectId, groupId });
    },

    async findUserRole(userId, projectId) {
      const entityManager = database.orm.em.fork();
      const groupIds = await listUserGroupIds(entityManager, userId);
      if (groupIds.length === 0) return null;
      const assignmentRows = await entityManager.find(RoleAssignmentRecord, {
        projectId,
        groupId: { $in: groupIds },
      });
      return assignmentRows.reduce<Role | null>(
        (highestRole, assignmentRow) => pickHigherRole(highestRole, assignmentRow.role as Role),
        null,
      );
    },

    async listUserRoles(userId) {
      const entityManager = database.orm.em.fork();
      const rolesByProject = new Map<string, Role>();
      const groupIds = await listUserGroupIds(entityManager, userId);
      if (groupIds.length === 0) return rolesByProject;
      const assignmentRows = await entityManager.find(RoleAssignmentRecord, {
        groupId: { $in: groupIds },
      });
      for (const assignmentRow of assignmentRows) {
        rolesByProject.set(
          assignmentRow.projectId,
          pickHigherRole(
            rolesByProject.get(assignmentRow.projectId) ?? null,
            assignmentRow.role as Role,
          )!,
        );
      }
      return rolesByProject;
    },
  };
}

/** Applies a changed mapping to the people the directory lists in the Company groups. */
async function reconcileMembersOfCompanyGroups(
  entityManager: EntityManager,
  groupId: string,
  companyGroupNames: string[],
  now: Date,
): Promise<void> {
  if (companyGroupNames.length === 0) return;
  const companyGroupRows = await entityManager.find(CompanyGroupRecord, {
    $or: [
      { displayName: { $in: companyGroupNames } },
      { externalId: { $in: companyGroupNames } },
    ],
  });
  if (companyGroupRows.length === 0) return;
  const memberRows = await entityManager.find(CompanyGroupMemberRecord, {
    companyGroupId: { $in: companyGroupRows.map((companyGroupRow) => companyGroupRow.id) },
  });
  await reconcileGroupMemberships(
    entityManager,
    [...new Set(memberRows.map((memberRow) => memberRow.userId))],
    [groupId],
    now,
  );
}

function createUserRow(newUser: NewUser, createdAt: Date): UserRow {
  return {
    id: generateTimeOrderedId(createdAt),
    ...newUser,
    oidcIssuer: null,
    oidcSubject: null,
    directorySource: null,
    directoryUserName: null,
    directoryExternalId: null,
    directoryRemovedAt: null,
    createdAt,
    deactivatedAt: null,
    personalDataDeletedAt: null,
  };
}

export function toUser(userRow: UserRow): User {
  return {
    id: userRow.id,
    email: userRow.email,
    displayName: userRow.displayName,
    isInstanceAdmin: Boolean(userRow.isInstanceAdmin),
    isLocalAccount: userRow.passwordHash !== null,
    directorySource: (userRow.directorySource ?? null) as User["directorySource"],
    createdAt: userRow.createdAt.toISOString(),
    deactivatedAt: userRow.deactivatedAt ? userRow.deactivatedAt.toISOString() : null,
    personalDataDeletedAt: userRow.personalDataDeletedAt
      ? userRow.personalDataDeletedAt.toISOString()
      : null,
  };
}

function toStoredUser(userRow: UserRow): StoredUser {
  return { ...toUser(userRow), passwordHash: userRow.passwordHash ?? null };
}

function toGroup(
  groupRow: GroupRow,
  memberRows: InferEntity<typeof GroupMemberRecord>[],
  memberUsers: UserRow[],
  mappingRows: InferEntity<typeof CompanyGroupMappingRecord>[],
): Group {
  const membershipsByUser = new Map(
    memberRows
      .filter((memberRow) => memberRow.groupId === groupRow.id)
      .map((memberRow) => [memberRow.userId, memberRow]),
  );
  return {
    id: groupRow.id,
    name: groupRow.name,
    createdAt: groupRow.createdAt.toISOString(),
    members: memberUsers
      .filter((memberUser) => membershipsByUser.has(memberUser.id))
      .map((memberUser) => ({
        id: memberUser.id,
        email: memberUser.email,
        displayName: memberUser.displayName,
        isFromCompanyGroup: Boolean(membershipsByUser.get(memberUser.id)!.isFromCompanyGroup),
      })),
    companyGroups: mappingRows
      .filter((mappingRow) => mappingRow.groupId === groupRow.id)
      .map((mappingRow) => mappingRow.companyGroupName),
  };
}
