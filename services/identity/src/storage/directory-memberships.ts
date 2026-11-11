import type { EntityManager, InferEntity } from "@mikro-orm/core";
import {
  CompanyGroupMappingRecord,
  CompanyGroupMemberRecord,
  CompanyGroupRecord,
  GroupMemberRecord,
  SignInRecord,
  UserRecord,
} from "./identity-entities.ts";

type CompanyGroupRow = InferEntity<typeof CompanyGroupRecord>;
type UserRow = InferEntity<typeof UserRecord>;

/**
 * The names a mapping may use for a Company group. A directory such as Microsoft Entra names a
 * group in SCIM but puts its ID in ID tokens, so a mapping to either one counts.
 */
export function listCompanyGroupNames(companyGroup: CompanyGroupRow): string[] {
  return companyGroup.externalId === null || companyGroup.externalId === undefined
    ? [companyGroup.displayName]
    : [companyGroup.displayName, companyGroup.externalId];
}

/** The Groups that the Company groups are mapped to. */
export async function findMappedGroupIds(
  entityManager: EntityManager,
  companyGroups: CompanyGroupRow[],
): Promise<string[]> {
  const companyGroupNames = companyGroups.flatMap(listCompanyGroupNames);
  if (companyGroupNames.length === 0) return [];
  const mappingRows = await entityManager.find(CompanyGroupMappingRecord, {
    companyGroupName: { $in: companyGroupNames },
  });
  return [...new Set(mappingRows.map((mappingRow) => mappingRow.groupId))];
}

/** The Company groups that the directory says the user belongs to. */
export async function findCompanyGroupsOfUser(
  entityManager: EntityManager,
  userId: string,
): Promise<CompanyGroupRow[]> {
  const memberRows = await entityManager.find(CompanyGroupMemberRecord, { userId });
  if (memberRows.length === 0) return [];
  return await entityManager.find(CompanyGroupRecord, {
    id: { $in: memberRows.map((memberRow) => memberRow.companyGroupId) },
  });
}

/**
 * Brings the users' memberships of these Groups in line with the directory: an active user in a
 * mapped Company group joins, and a membership that came from a Company group and is no longer
 * backed by one ends. It looks only at the given Groups, so a membership that an ID token gave for
 * some other Company group stays, and a membership added by hand is never touched.
 */
export async function reconcileGroupMemberships(
  entityManager: EntityManager,
  userIds: string[],
  groupIds: string[],
  now: Date,
): Promise<void> {
  if (userIds.length === 0 || groupIds.length === 0) return;
  const activeUserRows = await entityManager.find(UserRecord, {
    id: { $in: userIds },
    deactivatedAt: null,
  });
  const activeUserIds = new Set(activeUserRows.map((userRow) => userRow.id));
  const directoryRows = await entityManager.find(CompanyGroupMemberRecord, {
    userId: { $in: userIds },
  });
  const companyGroupRows = directoryRows.length === 0 ? [] : await entityManager.find(
    CompanyGroupRecord,
    { id: { $in: [...new Set(directoryRows.map((row) => row.companyGroupId))] } },
  );
  const companyGroupNames = companyGroupRows.flatMap(listCompanyGroupNames);
  const mappingRows = companyGroupNames.length === 0 ? [] : await entityManager.find(
    CompanyGroupMappingRecord,
    { companyGroupName: { $in: companyGroupNames }, groupId: { $in: groupIds } },
  );
  const groupIdsByName = new Map<string, string[]>();
  for (const mappingRow of mappingRows) {
    groupIdsByName.set(mappingRow.companyGroupName, [
      ...(groupIdsByName.get(mappingRow.companyGroupName) ?? []),
      mappingRow.groupId,
    ]);
  }
  const companyGroupsById = new Map(companyGroupRows.map((row) => [row.id, row]));
  const entitledGroupIdsByUser = new Map<string, Set<string>>();
  for (const directoryRow of directoryRows) {
    if (!activeUserIds.has(directoryRow.userId)) continue;
    const entitledGroupIds = entitledGroupIdsByUser.get(directoryRow.userId) ?? new Set<string>();
    for (const name of listCompanyGroupNames(companyGroupsById.get(directoryRow.companyGroupId)!)) {
      for (const groupId of groupIdsByName.get(name) ?? []) entitledGroupIds.add(groupId);
    }
    entitledGroupIdsByUser.set(directoryRow.userId, entitledGroupIds);
  }
  const membershipRows = await entityManager.find(GroupMemberRecord, {
    userId: { $in: userIds },
    groupId: { $in: groupIds },
  });
  const membershipsByKey = new Map(
    membershipRows.map((row) => [`${row.userId}/${row.groupId}`, row]),
  );
  for (const userId of new Set(userIds)) {
    const entitledGroupIds = entitledGroupIdsByUser.get(userId) ?? new Set<string>();
    for (const groupId of new Set(groupIds)) {
      const membershipRow = membershipsByKey.get(`${userId}/${groupId}`);
      if (entitledGroupIds.has(groupId) && membershipRow === undefined) {
        await entityManager.insert(GroupMemberRecord, {
          groupId,
          userId,
          addedAt: now,
          isFromCompanyGroup: true,
        });
      } else if (
        !entitledGroupIds.has(groupId) && membershipRow !== undefined &&
        membershipRow.isFromCompanyGroup
      ) {
        await entityManager.nativeDelete(GroupMemberRecord, { groupId, userId });
      }
    }
  }
}

/** Ends the user's sign-ins and every Group membership that a Company group gave them. */
export async function endDirectoryUserAccess(
  entityManager: EntityManager,
  userId: string,
): Promise<void> {
  await entityManager.nativeDelete(SignInRecord, { userId });
  await entityManager.nativeDelete(GroupMemberRecord, { userId, isFromCompanyGroup: true });
}

/** Whether deactivating this user would leave the Instance without an active Instance admin. */
export async function isLastActiveInstanceAdmin(
  entityManager: EntityManager,
  userRow: UserRow,
): Promise<boolean> {
  if (!userRow.isInstanceAdmin || userRow.deactivatedAt) return false;
  return await entityManager.count(UserRecord, {
    id: { $ne: userRow.id },
    isInstanceAdmin: true,
    deactivatedAt: null,
  }) === 0;
}
