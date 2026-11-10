import type {
  CompanyGroupSummary,
  DirectoryImportFormat,
  DirectoryImportProblem,
  DirectoryImportSummary,
  DirectoryImportUser,
  DirectorySource,
} from "@extispex/contracts";
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
  listCompanyGroupNames,
  reconcileGroupMemberships,
} from "./directory-memberships.ts";
import type { IdentityDatabase } from "./identity-database.ts";
import {
  CompanyGroupMappingRecord,
  CompanyGroupMemberRecord,
  CompanyGroupRecord,
  DirectoryImportRecord,
  GroupRecord,
  UserRecord,
} from "./identity-entities.ts";
import { generateTimeOrderedId } from "./time-ordered-id.ts";

type CompanyGroupRow = InferEntity<typeof CompanyGroupRecord>;
type UserRow = InferEntity<typeof UserRecord>;

/** One person from a file, with the row to name when something is wrong with it. */
export interface DirectoryImportRow extends DirectoryImportUser {
  rowNumber: number;
}

export type ImportDirectoryResult =
  | { status: "imported"; summary: DirectoryImportSummary }
  | { status: "rejected"; problems: DirectoryImportProblem[] };

export interface DirectoryOverview {
  provisionedUserCount: number;
  companyGroupCount: number;
  companyGroups: CompanyGroupSummary[];
  recentImports: DirectoryImportSummary[];
}

/** Applying imported files, and what the Access page shows about the directory. */
export interface DirectoryImportRepository {
  /** Applies every row or, when any row cannot be applied, none. */
  importUsers(
    rows: DirectoryImportRow[],
    format: DirectoryImportFormat,
    importedByUserId: string,
    now: Date,
  ): Promise<ImportDirectoryResult>;
  readOverview(): Promise<DirectoryOverview>;
}

class ImportRejected extends Error {
  constructor(readonly problems: DirectoryImportProblem[]) {
    super("The file cannot be applied.");
  }
}

const SHOWN_COMPANY_GROUP_COUNT = 200;
const SHOWN_IMPORT_COUNT = 5;

type RowOutcome = "created" | "updated" | "deactivated" | "unchanged";

export function createDirectoryImportRepository(
  database: IdentityDatabase,
): DirectoryImportRepository {
  const applyFile = (
    rows: DirectoryImportRow[],
    format: DirectoryImportFormat,
    importedByUserId: string,
    now: Date,
  ) =>
    database.orm.em.fork().transactional(async (entityManager) => {
      const problems: DirectoryImportProblem[] = [];
      const companyGroupsByName = new Map<string, CompanyGroupRow>();
      const outcomes: RowOutcome[] = [];
      for (const row of rows) {
        const outcome = await applyRow(entityManager, row, companyGroupsByName, problems, now);
        if (outcome !== null) outcomes.push(outcome);
      }
      if (problems.length > 0) throw new ImportRejected(problems);
      const countOutcomes = (wanted: RowOutcome) =>
        outcomes.filter((outcome) => outcome === wanted).length;
      const importRow = {
        id: generateTimeOrderedId(now),
        importedAt: now,
        importedByUserId,
        format,
        rowCount: rows.length,
        createdCount: countOutcomes("created"),
        updatedCount: countOutcomes("updated"),
        deactivatedCount: countOutcomes("deactivated"),
        unchangedCount: countOutcomes("unchanged"),
      };
      await entityManager.insert(DirectoryImportRecord, importRow);
      return toImportSummary(importRow);
    });

  return {
    async importUsers(rows, format, importedByUserId, now) {
      const duplicateProblems = findDuplicateEmails(rows);
      if (duplicateProblems.length > 0) {
        return { status: "rejected", problems: duplicateProblems };
      }
      // A SCIM request can create the same user or Company group between the check and the insert.
      for (let attemptNumber = 1;; attemptNumber++) {
        try {
          const summary = await applyFile(rows, format, importedByUserId, now);
          return { status: "imported", summary };
        } catch (error) {
          if (error instanceof ImportRejected) {
            return { status: "rejected", problems: error.problems };
          }
          if (!(error instanceof UniqueConstraintViolationException) || attemptNumber === 2) {
            throw error;
          }
        }
      }
    },

    async readOverview() {
      const entityManager = database.orm.em.fork();
      const [provisionedUserCount, companyGroupCount, groupRows, importRows] = await Promise.all([
        entityManager.fork().count(UserRecord, { directorySource: { $ne: null } }),
        entityManager.fork().count(CompanyGroupRecord, {}),
        entityManager.fork().find(CompanyGroupRecord, {}, {
          orderBy: { displayName: "asc" },
          limit: SHOWN_COMPANY_GROUP_COUNT,
        }),
        entityManager.fork().find(DirectoryImportRecord, {}, {
          orderBy: { importedAt: "desc", id: "desc" },
          limit: SHOWN_IMPORT_COUNT,
        }),
      ]);
      const memberCountRows = await entityManager.execute<
        { company_group_id: string; member_count: number | string }[]
      >(
        "select company_group_id, count(*) as member_count from company_group_members " +
          "group by company_group_id",
      );
      const memberCounts = new Map(
        memberCountRows.map((row) => [row.company_group_id, Number(row.member_count)]),
      );
      const mappingRows = groupRows.length === 0 ? [] : await entityManager.find(
        CompanyGroupMappingRecord,
        { companyGroupName: { $in: groupRows.flatMap(listCompanyGroupNames) } },
      );
      const mappedGroupRows = mappingRows.length === 0 ? [] : await entityManager.find(
        GroupRecord,
        { id: { $in: [...new Set(mappingRows.map((mappingRow) => mappingRow.groupId))] } },
        { orderBy: { name: "asc" } },
      );
      return {
        provisionedUserCount,
        companyGroupCount,
        companyGroups: groupRows.map((groupRow) => {
          const names = new Set(listCompanyGroupNames(groupRow));
          const mappedGroupIds = new Set(
            mappingRows.filter((mappingRow) => names.has(mappingRow.companyGroupName))
              .map((mappingRow) => mappingRow.groupId),
          );
          return {
            id: groupRow.id,
            displayName: groupRow.displayName,
            externalId: groupRow.externalId ?? null,
            source: groupRow.source as DirectorySource,
            memberCount: memberCounts.get(groupRow.id) ?? 0,
            mappedGroups: mappedGroupRows
              .filter((mappedGroupRow) => mappedGroupIds.has(mappedGroupRow.id))
              .map(({ id, name }) => ({ id, name })),
          };
        }),
        recentImports: importRows.map(toImportSummary),
      };
    },
  };
}

function findDuplicateEmails(rows: DirectoryImportRow[]): DirectoryImportProblem[] {
  const firstRowByEmail = new Map<string, number>();
  const problems: DirectoryImportProblem[] = [];
  for (const row of rows) {
    const firstRow = firstRowByEmail.get(row.email);
    if (firstRow === undefined) {
      firstRowByEmail.set(row.email, row.rowNumber);
    } else {
      problems.push({
        row: row.rowNumber,
        message: `${row.email} is already on row ${firstRow}.`,
      });
    }
  }
  return problems;
}

/** Applies one row. Null, with a problem recorded, when the row cannot be applied. */
async function applyRow(
  entityManager: EntityManager,
  row: DirectoryImportRow,
  companyGroupsByName: Map<string, CompanyGroupRow>,
  problems: DirectoryImportProblem[],
  now: Date,
): Promise<RowOutcome | null> {
  let userRow = await entityManager.findOne(UserRecord, { email: row.email });
  let outcome: RowOutcome = "unchanged";
  if (userRow !== null && userRow.passwordHash !== null) {
    problems.push({
      row: row.rowNumber,
      message: `${row.email} is a local account, which an import cannot change.`,
    });
    return null;
  }
  if (userRow === null) {
    userRow = {
      id: generateTimeOrderedId(now),
      email: row.email,
      displayName: row.displayName,
      passwordHash: null,
      oidcIssuer: null,
      oidcSubject: null,
      directorySource: "import",
      directoryUserName: null,
      directoryExternalId: null,
      directoryRemovedAt: null,
      isInstanceAdmin: false,
      createdAt: now,
      deactivatedAt: row.active === false ? now : null,
    };
    await entityManager.insert(UserRecord, userRow);
    outcome = "created";
  } else {
    const isDeactivating = row.active === false && !userRow.deactivatedAt;
    const isReactivating = row.active === true && Boolean(userRow.deactivatedAt);
    if (isDeactivating && await isLastActiveInstanceAdmin(entityManager, userRow)) {
      problems.push({
        row: row.rowNumber,
        message: `${row.email} is the last active Instance admin, who cannot be deactivated.`,
      });
      return null;
    }
    const changedFields: Partial<UserRow> = {};
    if (userRow.displayName !== row.displayName) changedFields.displayName = row.displayName;
    if (!userRow.directorySource) changedFields.directorySource = "import";
    if (isDeactivating) changedFields.deactivatedAt = now;
    if (isReactivating) {
      changedFields.deactivatedAt = null;
      changedFields.directoryRemovedAt = null;
    }
    if (Object.keys(changedFields).length > 0) {
      await entityManager.nativeUpdate(UserRecord, { id: userRow.id }, changedFields);
      userRow = { ...userRow, ...changedFields };
      outcome = "updated";
    }
    if (isDeactivating) {
      await endDirectoryUserAccess(entityManager, userRow.id);
      outcome = "deactivated";
    }
    if (isReactivating) {
      await reconcileGroupMemberships(
        entityManager,
        [userRow.id],
        await findMappedGroupIds(
          entityManager,
          await findCompanyGroupsOfUser(entityManager, userRow.id),
        ),
        now,
      );
    }
  }
  if (row.companyGroups !== undefined) {
    const hasChanged = await replaceCompanyGroups(
      entityManager,
      userRow.id,
      row.companyGroups,
      companyGroupsByName,
      now,
    );
    if (hasChanged && outcome === "unchanged") outcome = "updated";
  }
  return outcome;
}

/** Makes the user's Company groups the given ones. True when that changed anything. */
async function replaceCompanyGroups(
  entityManager: EntityManager,
  userId: string,
  companyGroupNames: string[],
  companyGroupsByName: Map<string, CompanyGroupRow>,
  now: Date,
): Promise<boolean> {
  const desiredRows = await findOrCreateCompanyGroups(
    entityManager,
    [...new Set(companyGroupNames)],
    companyGroupsByName,
    now,
  );
  const currentRows = await findCompanyGroupsOfUser(entityManager, userId);
  const currentIds = new Set(currentRows.map((companyGroup) => companyGroup.id));
  const desiredIds = new Set(desiredRows.map((companyGroup) => companyGroup.id));
  const removedRows = currentRows.filter((companyGroup) => !desiredIds.has(companyGroup.id));
  const addedRows = desiredRows.filter((companyGroup) => !currentIds.has(companyGroup.id));
  if (removedRows.length === 0 && addedRows.length === 0) return false;
  for (const companyGroup of removedRows) {
    await entityManager.nativeDelete(CompanyGroupMemberRecord, {
      companyGroupId: companyGroup.id,
      userId,
    });
  }
  for (const companyGroup of addedRows) {
    await entityManager.insert(CompanyGroupMemberRecord, {
      companyGroupId: companyGroup.id,
      userId,
      addedAt: now,
    });
  }
  await reconcileGroupMemberships(
    entityManager,
    [userId],
    await findMappedGroupIds(entityManager, [...removedRows, ...addedRows]),
    now,
  );
  return true;
}

async function findOrCreateCompanyGroups(
  entityManager: EntityManager,
  names: string[],
  companyGroupsByName: Map<string, CompanyGroupRow>,
  now: Date,
): Promise<CompanyGroupRow[]> {
  const companyGroups: CompanyGroupRow[] = [];
  for (const displayName of names) {
    let companyGroup = companyGroupsByName.get(displayName) ??
      await entityManager.findOne(CompanyGroupRecord, { displayName });
    if (companyGroup === null) {
      companyGroup = {
        id: generateTimeOrderedId(now),
        displayName,
        externalId: null,
        source: "import",
        createdAt: now,
      };
      await entityManager.insert(CompanyGroupRecord, companyGroup);
    }
    companyGroupsByName.set(displayName, companyGroup);
    companyGroups.push(companyGroup);
  }
  return companyGroups;
}

function toImportSummary(
  importRow: InferEntity<typeof DirectoryImportRecord>,
): DirectoryImportSummary {
  return {
    id: importRow.id,
    importedAt: importRow.importedAt.toISOString(),
    format: importRow.format as DirectoryImportFormat,
    rowCount: importRow.rowCount,
    createdCount: importRow.createdCount,
    updatedCount: importRow.updatedCount,
    deactivatedCount: importRow.deactivatedCount,
    unchangedCount: importRow.unchangedCount,
  };
}
