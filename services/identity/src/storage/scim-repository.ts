import {
  type EntityManager,
  type InferEntity,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import {
  endDirectoryUserAccess,
  findCompanyGroupsOfUser,
  findMappedGroupIds,
  isLastActiveInstanceAdmin,
  reconcileGroupMemberships,
} from "./directory-memberships.ts";
import type { IdentityDatabase } from "./identity-database.ts";
import {
  CompanyGroupMappingRecord,
  CompanyGroupMemberRecord,
  CompanyGroupRecord,
  UserRecord,
} from "./identity-entities.ts";
import { generateTimeOrderedId } from "./time-ordered-id.ts";

type UserRow = InferEntity<typeof UserRecord>;
type CompanyGroupRow = InferEntity<typeof CompanyGroupRecord>;

/** A user's attributes that the directory controls. */
export interface DirectoryUserAttributes {
  userName: string;
  email: string;
  displayName: string;
  externalId: string | null;
  isActive: boolean;
}

export interface DirectoryUser extends DirectoryUserAttributes {
  id: string;
  createdAt: Date;
}

export interface CompanyGroupAttributes {
  displayName: string;
  externalId: string | null;
  memberIds: string[];
}

export interface CompanyGroupMember {
  id: string;
  displayName: string;
}

export interface DirectoryCompanyGroup {
  id: string;
  displayName: string;
  externalId: string | null;
  createdAt: Date;
  members: CompanyGroupMember[];
}

export interface ResourcePage {
  offset: number;
  limit: number;
}

export interface ResourceList<Resource> {
  totalCount: number;
  resources: Resource[];
}

export type DirectoryUserFilter = { userName?: string; externalId?: string; id?: string };
export type CompanyGroupFilter = { displayName?: string; externalId?: string; id?: string };

export type SaveUserResult =
  | { status: "saved"; user: DirectoryUser }
  | { status: "conflict" }
  | { status: "last_instance_admin" };
export type ModifyUserResult = SaveUserResult | { status: "not_found" };
export type RemoveUserResult =
  | { status: "removed" }
  | { status: "not_found" }
  | { status: "last_instance_admin" };
export type SaveCompanyGroupResult =
  | { status: "saved"; companyGroup: DirectoryCompanyGroup }
  | { status: "conflict" }
  | { status: "unknown_member"; userId: string };
export type ModifyCompanyGroupResult = SaveCompanyGroupResult | { status: "not_found" };

/**
 * Users and Company groups as the company's directory sees them over SCIM. It sees only what it
 * manages itself: local accounts stay out of its reach, including a break-glass Instance admin.
 */
export interface ScimRepository {
  listUsers(filter: DirectoryUserFilter, page: ResourcePage): Promise<ResourceList<DirectoryUser>>;
  findUser(userId: string): Promise<DirectoryUser | null>;
  /**
   * Creates the user, or takes over one without a password that the directory does not manage yet,
   * such as someone who has already signed in through OIDC.
   */
  createUser(attributes: DirectoryUserAttributes, now: Date): Promise<SaveUserResult>;
  modifyUser(
    userId: string,
    applyChanges: (currentUser: DirectoryUser) => DirectoryUserAttributes,
    now: Date,
  ): Promise<ModifyUserResult>;
  /** Deactivates the user and hides them from SCIM. Creating them again reactivates them. */
  removeUser(userId: string, now: Date): Promise<RemoveUserResult>;

  listCompanyGroups(
    filter: CompanyGroupFilter,
    page: ResourcePage,
    includeMembers: boolean,
  ): Promise<ResourceList<DirectoryCompanyGroup>>;
  findCompanyGroup(companyGroupId: string): Promise<DirectoryCompanyGroup | null>;
  createCompanyGroup(
    attributes: CompanyGroupAttributes,
    now: Date,
  ): Promise<SaveCompanyGroupResult>;
  modifyCompanyGroup(
    companyGroupId: string,
    applyChanges: (currentGroup: DirectoryCompanyGroup) => CompanyGroupAttributes,
    now: Date,
  ): Promise<ModifyCompanyGroupResult>;
  /** False for an unknown Company group. A mapping to its name stays. */
  removeCompanyGroup(companyGroupId: string, now: Date): Promise<boolean>;
}

/** Ends the transaction and undoes what it did, carrying the answer for the caller. */
class RollbackWith<Answer> extends Error {
  constructor(readonly answer: Answer) {
    super("The transaction is rolled back.");
  }
}

const MANAGED_USER = { directorySource: "scim", directoryRemovedAt: null } as const;

export function createScimRepository(database: IdentityDatabase): ScimRepository {
  const runInTransaction = async <Answer>(
    work: (entityManager: EntityManager) => Promise<Answer>,
    conflictAnswer: Answer,
  ): Promise<Answer> => {
    // Two updates of one Company group can insert the same member, so one more try settles it.
    for (let attemptNumber = 1;; attemptNumber++) {
      try {
        return await database.orm.em.fork().transactional(work);
      } catch (error) {
        if (error instanceof RollbackWith) return error.answer as Answer;
        if (!(error instanceof UniqueConstraintViolationException)) throw error;
        if (attemptNumber === 2) return conflictAnswer;
      }
    }
  };

  const readMembers = async (entityManager: EntityManager, groupRows: CompanyGroupRow[]) => {
    const membersByGroup = new Map<string, CompanyGroupMember[]>(
      groupRows.map((groupRow) => [groupRow.id, []]),
    );
    if (groupRows.length === 0) return membersByGroup;
    const memberRows = await entityManager.find(CompanyGroupMemberRecord, {
      companyGroupId: { $in: groupRows.map((groupRow) => groupRow.id) },
    });
    if (memberRows.length === 0) return membersByGroup;
    const userRows = await entityManager.find(UserRecord, {
      id: { $in: [...new Set(memberRows.map((memberRow) => memberRow.userId))] },
    });
    const usersById = new Map(userRows.map((userRow) => [userRow.id, userRow]));
    for (const memberRow of memberRows) {
      membersByGroup.get(memberRow.companyGroupId)!.push({
        id: memberRow.userId,
        displayName: usersById.get(memberRow.userId)!.displayName,
      });
    }
    return membersByGroup;
  };

  const toDirectoryCompanyGroup = (
    groupRow: CompanyGroupRow,
    members: CompanyGroupMember[],
  ): DirectoryCompanyGroup => ({
    id: groupRow.id,
    displayName: groupRow.displayName,
    externalId: groupRow.externalId ?? null,
    createdAt: groupRow.createdAt,
    members,
  });

  const readCompanyGroup = async (entityManager: EntityManager, groupRow: CompanyGroupRow) =>
    toDirectoryCompanyGroup(
      groupRow,
      (await readMembers(entityManager, [groupRow])).get(groupRow.id)!,
    );

  /** Writes the attributes and ends or restores the user's access when `isActive` changed. */
  const saveUserAttributes = async (
    entityManager: EntityManager,
    userRow: UserRow,
    attributes: DirectoryUserAttributes,
    now: Date,
  ): Promise<UserRow> => {
    const isDeactivating = !attributes.isActive && !userRow.deactivatedAt;
    const isReactivating = attributes.isActive && Boolean(userRow.deactivatedAt);
    if (isDeactivating && await isLastActiveInstanceAdmin(entityManager, userRow)) {
      throw new RollbackWith({ status: "last_instance_admin" } as const);
    }
    const changedFields = {
      email: attributes.email,
      displayName: attributes.displayName,
      directorySource: "scim",
      directoryUserName: attributes.userName,
      directoryExternalId: attributes.externalId,
      directoryRemovedAt: null,
      deactivatedAt: attributes.isActive ? null : userRow.deactivatedAt ?? now,
    };
    await entityManager.nativeUpdate(UserRecord, { id: userRow.id }, changedFields);
    if (isDeactivating) await endDirectoryUserAccess(entityManager, userRow.id);
    if (isReactivating) {
      const companyGroups = await findCompanyGroupsOfUser(entityManager, userRow.id);
      await reconcileGroupMemberships(
        entityManager,
        [userRow.id],
        await findMappedGroupIds(entityManager, companyGroups),
        now,
      );
    }
    return { ...userRow, ...changedFields };
  };

  const assertMembersExist = async (entityManager: EntityManager, memberIds: string[]) => {
    if (memberIds.length === 0) return;
    const userRows = await entityManager.find(UserRecord, {
      id: { $in: memberIds },
      passwordHash: null,
      directoryRemovedAt: null,
    });
    const knownUserIds = new Set(userRows.map((userRow) => userRow.id));
    const unknownUserId = memberIds.find((memberId) => !knownUserIds.has(memberId));
    if (unknownUserId !== undefined) {
      throw new RollbackWith({ status: "unknown_member", userId: unknownUserId } as const);
    }
  };

  /** Writes the Company group and moves the people it adds or removes in and out of Groups. */
  const saveCompanyGroup = async (
    entityManager: EntityManager,
    groupRow: CompanyGroupRow,
    attributes: CompanyGroupAttributes,
    now: Date,
  ): Promise<DirectoryCompanyGroup> => {
    const memberIds = [...new Set(attributes.memberIds)];
    await assertMembersExist(entityManager, memberIds);
    const mappedGroupIdsBefore = await findMappedGroupIds(entityManager, [groupRow]);
    if (groupRow.displayName !== attributes.displayName) {
      await moveMappingsToNewName(entityManager, groupRow.displayName, attributes.displayName);
    }
    const updatedRow = {
      ...groupRow,
      displayName: attributes.displayName,
      externalId: attributes.externalId,
      source: "scim",
    };
    await entityManager.nativeUpdate(CompanyGroupRecord, { id: groupRow.id }, {
      displayName: updatedRow.displayName,
      externalId: updatedRow.externalId,
      source: updatedRow.source,
    });
    const memberRows = await entityManager.find(CompanyGroupMemberRecord, {
      companyGroupId: groupRow.id,
    });
    const currentIds = new Set(memberRows.map((memberRow) => memberRow.userId));
    const desiredIds = new Set(memberIds);
    for (const userId of currentIds) {
      if (!desiredIds.has(userId)) {
        await entityManager.nativeDelete(CompanyGroupMemberRecord, {
          companyGroupId: groupRow.id,
          userId,
        });
      }
    }
    for (const userId of desiredIds) {
      if (!currentIds.has(userId)) {
        await entityManager.insert(CompanyGroupMemberRecord, {
          companyGroupId: groupRow.id,
          userId,
          addedAt: now,
        });
      }
    }
    const mappedGroupIds = [
      ...new Set([
        ...mappedGroupIdsBefore,
        ...await findMappedGroupIds(entityManager, [updatedRow]),
      ]),
    ];
    await reconcileGroupMemberships(
      entityManager,
      [...new Set([...currentIds, ...desiredIds])],
      mappedGroupIds,
      now,
    );
    return await readCompanyGroup(entityManager, updatedRow);
  };

  return {
    async listUsers(filter, page) {
      const entityManager = database.orm.em.fork();
      const where = {
        ...MANAGED_USER,
        ...(filter.id === undefined ? {} : { id: filter.id }),
        ...(filter.userName === undefined ? {} : { directoryUserName: filter.userName }),
        ...(filter.externalId === undefined ? {} : { directoryExternalId: filter.externalId }),
      };
      const [totalCount, userRows] = await Promise.all([
        entityManager.fork().count(UserRecord, where),
        entityManager.fork().find(UserRecord, where, {
          orderBy: { id: "asc" },
          offset: page.offset,
          limit: page.limit,
        }),
      ]);
      return { totalCount, resources: userRows.map(toDirectoryUser) };
    },

    async findUser(userId) {
      const userRow = await database.orm.em.fork().findOne(UserRecord, {
        id: userId,
        ...MANAGED_USER,
      });
      return userRow === null ? null : toDirectoryUser(userRow);
    },

    async createUser(attributes, now) {
      return await runInTransaction<SaveUserResult>(async (entityManager) => {
        const existingRows = await entityManager.find(UserRecord, {
          $or: [{ email: attributes.email }, { directoryUserName: attributes.userName }],
        });
        if (existingRows.length > 1) return { status: "conflict" };
        const [existingRow] = existingRows;
        if (existingRow === undefined) {
          const userRow = {
            id: generateTimeOrderedId(now),
            email: attributes.email,
            displayName: attributes.displayName,
            passwordHash: null,
            oidcIssuer: null,
            oidcSubject: null,
            directorySource: "scim",
            directoryUserName: attributes.userName,
            directoryExternalId: attributes.externalId,
            directoryRemovedAt: null,
            isInstanceAdmin: false,
            createdAt: now,
            deactivatedAt: attributes.isActive ? null : now,
          };
          await entityManager.insert(UserRecord, userRow);
          return { status: "saved", user: toDirectoryUser(userRow) };
        }
        const isManagedAlready = existingRow.directorySource === "scim" &&
          !existingRow.directoryRemovedAt;
        if (existingRow.passwordHash !== null || isManagedAlready) return { status: "conflict" };
        const savedRow = await saveUserAttributes(entityManager, existingRow, attributes, now);
        return { status: "saved", user: toDirectoryUser(savedRow) };
      }, { status: "conflict" });
    },

    async modifyUser(userId, applyChanges, now) {
      return await runInTransaction<ModifyUserResult>(async (entityManager) => {
        const userRow = await entityManager.findOne(UserRecord, { id: userId, ...MANAGED_USER });
        if (userRow === null) return { status: "not_found" };
        const attributes = applyChanges(toDirectoryUser(userRow));
        const savedRow = await saveUserAttributes(entityManager, userRow, attributes, now);
        return { status: "saved", user: toDirectoryUser(savedRow) };
      }, { status: "conflict" });
    },

    async removeUser(userId, now) {
      return await runInTransaction<RemoveUserResult>(async (entityManager) => {
        const userRow = await entityManager.findOne(UserRecord, { id: userId, ...MANAGED_USER });
        if (userRow === null) return { status: "not_found" };
        if (await isLastActiveInstanceAdmin(entityManager, userRow)) {
          return { status: "last_instance_admin" };
        }
        await entityManager.nativeUpdate(UserRecord, { id: userId }, {
          deactivatedAt: userRow.deactivatedAt ?? now,
          directoryRemovedAt: now,
        });
        await endDirectoryUserAccess(entityManager, userId);
        await entityManager.nativeDelete(CompanyGroupMemberRecord, { userId });
        return { status: "removed" };
      }, { status: "not_found" });
    },

    async listCompanyGroups(filter, page, includeMembers) {
      const entityManager = database.orm.em.fork();
      const where = {
        source: "scim",
        ...(filter.id === undefined ? {} : { id: filter.id }),
        ...(filter.displayName === undefined ? {} : { displayName: filter.displayName }),
        ...(filter.externalId === undefined ? {} : { externalId: filter.externalId }),
      };
      const [totalCount, groupRows] = await Promise.all([
        entityManager.fork().count(CompanyGroupRecord, where),
        entityManager.fork().find(CompanyGroupRecord, where, {
          orderBy: { id: "asc" },
          offset: page.offset,
          limit: page.limit,
        }),
      ]);
      const membersByGroup = includeMembers
        ? await readMembers(entityManager, groupRows)
        : new Map<string, CompanyGroupMember[]>();
      return {
        totalCount,
        resources: groupRows.map((groupRow) =>
          toDirectoryCompanyGroup(groupRow, membersByGroup.get(groupRow.id) ?? [])
        ),
      };
    },

    async findCompanyGroup(companyGroupId) {
      const entityManager = database.orm.em.fork();
      const groupRow = await entityManager.findOne(CompanyGroupRecord, {
        id: companyGroupId,
        source: "scim",
      });
      return groupRow === null ? null : await readCompanyGroup(entityManager, groupRow);
    },

    async createCompanyGroup(attributes, now) {
      return await runInTransaction<SaveCompanyGroupResult>(async (entityManager) => {
        const existingRow = await entityManager.findOne(CompanyGroupRecord, {
          displayName: attributes.displayName,
        });
        // A Company group that a file brought in moves to the directory when it first names it.
        if (existingRow?.source === "scim") return { status: "conflict" };
        let groupRow = existingRow;
        if (groupRow === null) {
          groupRow = {
            id: generateTimeOrderedId(now),
            displayName: attributes.displayName,
            externalId: attributes.externalId,
            source: "scim",
            createdAt: now,
          };
          await entityManager.insert(CompanyGroupRecord, groupRow);
        }
        const companyGroup = await saveCompanyGroup(entityManager, groupRow, attributes, now);
        return { status: "saved", companyGroup };
      }, { status: "conflict" });
    },

    async modifyCompanyGroup(companyGroupId, applyChanges, now) {
      return await runInTransaction<ModifyCompanyGroupResult>(async (entityManager) => {
        const groupRow = await entityManager.findOne(CompanyGroupRecord, {
          id: companyGroupId,
          source: "scim",
        });
        if (groupRow === null) return { status: "not_found" };
        const currentGroup = await readCompanyGroup(entityManager, groupRow);
        const companyGroup = await saveCompanyGroup(
          entityManager,
          groupRow,
          applyChanges(currentGroup),
          now,
        );
        return { status: "saved", companyGroup };
      }, { status: "conflict" });
    },

    async removeCompanyGroup(companyGroupId, now) {
      return await runInTransaction<boolean>(async (entityManager) => {
        const groupRow = await entityManager.findOne(CompanyGroupRecord, {
          id: companyGroupId,
          source: "scim",
        });
        if (groupRow === null) return false;
        const memberRows = await entityManager.find(CompanyGroupMemberRecord, {
          companyGroupId,
        });
        const mappedGroupIds = await findMappedGroupIds(entityManager, [groupRow]);
        await entityManager.nativeDelete(CompanyGroupMemberRecord, { companyGroupId });
        await entityManager.nativeDelete(CompanyGroupRecord, { id: companyGroupId });
        await reconcileGroupMemberships(
          entityManager,
          memberRows.map((memberRow) => memberRow.userId),
          mappedGroupIds,
          now,
        );
        return true;
      }, false);
    },
  };
}

/** Keeps a Group's mapping working when the directory renames the Company group. */
async function moveMappingsToNewName(
  entityManager: EntityManager,
  oldName: string,
  newName: string,
): Promise<void> {
  const mappingRows = await entityManager.find(CompanyGroupMappingRecord, {
    companyGroupName: oldName,
  });
  for (const mappingRow of mappingRows) {
    await entityManager.nativeDelete(CompanyGroupMappingRecord, {
      companyGroupName: oldName,
      groupId: mappingRow.groupId,
    });
    const isMappedAlready = await entityManager.count(CompanyGroupMappingRecord, {
      companyGroupName: newName,
      groupId: mappingRow.groupId,
    }) > 0;
    if (!isMappedAlready) {
      await entityManager.insert(CompanyGroupMappingRecord, {
        companyGroupName: newName,
        groupId: mappingRow.groupId,
      });
    }
  }
}

function toDirectoryUser(userRow: UserRow): DirectoryUser {
  return {
    id: userRow.id,
    userName: userRow.directoryUserName ?? userRow.email,
    email: userRow.email,
    displayName: userRow.displayName,
    externalId: userRow.directoryExternalId ?? null,
    isActive: !userRow.deactivatedAt,
    createdAt: userRow.createdAt,
  };
}
