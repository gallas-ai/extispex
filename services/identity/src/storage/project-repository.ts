import {
  type ApiKey,
  DEFAULT_RETENTION_DAYS,
  type DeletedProject,
  type Project,
  PROJECT_DATA_SERVICES,
  type ProjectLifecycle,
} from "@extispex/contracts";
import { type InferEntity, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { IdentityDatabase } from "./identity-database.ts";
import {
  ApiKeyRecord,
  ProjectDataRemovalRecord,
  ProjectRecord,
  RoleAssignmentRecord,
} from "./identity-entities.ts";
import { generateTimeOrderedId } from "./time-ordered-id.ts";

/** An API key as stored: its hash and readable prefix, never the key itself. */
export interface NewApiKey {
  name: string;
  keyPrefix: string;
  keyHash: string;
}

export type CreateProjectResult =
  | { status: "created"; project: Project }
  | { status: "name_taken" };

export type CreateFirstProjectResult =
  | { status: "created"; project: Project }
  | { status: "projects_exist" };

export type RevokeApiKeyResult = "revoked" | "already_revoked" | "not_found";

export interface ProjectRepository {
  createProject(name: string, createdAt: Date): Promise<CreateProjectResult>;
  /**
   * Creates a Project with one API key, in one transaction, only while the Instance has no
   * Project at all, deleted ones included. Safe when several replicas start at once.
   */
  createFirstProject(
    name: string,
    apiKey: NewApiKey,
    createdAt: Date,
  ): Promise<CreateFirstProjectResult>;
  /** Projects that are not deleted, by name. */
  listProjects(): Promise<Project[]>;
  /** Null for an unknown or deleted Project. */
  findProject(projectId: string): Promise<Project | null>;
  /** Null for an unknown or deleted Project. */
  setRetentionDays(projectId: string, retentionDays: number): Promise<Project | null>;
  /** False for an unknown or already deleted Project. */
  deleteProject(projectId: string, deletedAt: Date): Promise<boolean>;
  /**
   * Every Project's Retention Period, and the deleted Projects whose data the service has not yet
   * removed after `finalRemovalAfter`: a removal only counts once no access token issued before
   * the deletion can still write more, which is the deletion time plus the tokens' lifetime.
   */
  readProjectLifecycle(service: string, accessTokenLifetimeMilliseconds: number): Promise<
    ProjectLifecycle
  >;
  /** False when no deleted Project has this ID. */
  recordDataRemoval(projectId: string, service: string, removedAt: Date): Promise<boolean>;
  /** Newest first. */
  listDeletedProjects(
    limit: number,
    accessTokenLifetimeMilliseconds: number,
  ): Promise<DeletedProject[]>;
  /** Removes Identity's own data of a deleted Project: its API keys and Role assignments. */
  removeOwnProjectData(projectId: string): Promise<void>;
  createApiKey(projectId: string, apiKey: NewApiKey, createdAt: Date): Promise<ApiKey>;
  /** Newest first, revoked keys included. */
  listApiKeys(projectId: string): Promise<ApiKey[]>;
  revokeApiKey(projectId: string, apiKeyId: string, revokedAt: Date): Promise<RevokeApiKeyResult>;
  /** The Project of a key that is not revoked and whose Project is not deleted, or null. */
  findProjectIdByKeyHash(keyHash: string): Promise<string | null>;
}

type ProjectRow = InferEntity<typeof ProjectRecord>;
type ApiKeyRow = InferEntity<typeof ApiKeyRecord>;

export function createProjectRepository(database: IdentityDatabase): ProjectRepository {
  return {
    async createProject(name, createdAt) {
      const projectRow = createProjectRow(name, createdAt);
      try {
        await database.orm.em.fork().insert(ProjectRecord, projectRow);
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) return { status: "name_taken" };
        throw error;
      }
      return { status: "created", project: toProject(projectRow) };
    },

    async createFirstProject(name, apiKey, createdAt) {
      const projectRow = createProjectRow(name, createdAt);
      try {
        return await database.orm.em.fork().transactional(async (entityManager) => {
          if (await entityManager.count(ProjectRecord, {}) > 0) {
            return { status: "projects_exist" } as const;
          }
          await entityManager.insert(ProjectRecord, projectRow);
          await entityManager.insert(ApiKeyRecord, {
            id: generateTimeOrderedId(createdAt),
            projectId: projectRow.id,
            ...apiKey,
            createdAt,
            revokedAt: null,
          });
          return { status: "created", project: toProject(projectRow) } as const;
        });
      } catch (error) {
        // Another replica created the first Project between the count and the insert.
        if (error instanceof UniqueConstraintViolationException) {
          return { status: "projects_exist" };
        }
        throw error;
      }
    },

    async listProjects() {
      const projectRows = await database.orm.em.fork().find(
        ProjectRecord,
        { deletedAt: null },
        { orderBy: { name: "asc" } },
      );
      return projectRows.map(toProject);
    },

    async findProject(projectId) {
      const projectRow = await database.orm.em.fork().findOne(ProjectRecord, {
        id: projectId,
        deletedAt: null,
      });
      return projectRow === null ? null : toProject(projectRow);
    },

    async setRetentionDays(projectId, retentionDays) {
      const entityManager = database.orm.em.fork();
      const updatedCount = await entityManager.nativeUpdate(
        ProjectRecord,
        { id: projectId, deletedAt: null },
        { retentionDays },
      );
      if (updatedCount === 0) return null;
      const projectRow = await entityManager.findOne(ProjectRecord, { id: projectId });
      return projectRow === null ? null : toProject(projectRow);
    },

    async readProjectLifecycle(service, accessTokenLifetimeMilliseconds) {
      const entityManager = database.orm.em.fork();
      const [projectRows, deletedRows, removalRows] = await Promise.all([
        entityManager.fork().find(ProjectRecord, { deletedAt: null }, { orderBy: { id: "asc" } }),
        entityManager.fork().find(
          ProjectRecord,
          { deletedAt: { $ne: null } },
          { orderBy: { deletedAt: "asc" } },
        ),
        entityManager.fork().find(ProjectDataRemovalRecord, { service }),
      ]);
      const removedAtByProject = new Map(
        removalRows.map((removalRow) => [removalRow.projectId, removalRow.removedAt]),
      );
      return {
        projects: projectRows.map((projectRow) => ({
          projectId: projectRow.id,
          retentionDays: projectRow.retentionDays,
        })),
        projectsToRemove: deletedRows
          .filter((projectRow) =>
            !isRemovalFinal(
              projectRow.deletedAt!,
              removedAtByProject.get(projectRow.id),
              accessTokenLifetimeMilliseconds,
            )
          )
          .map((projectRow) => ({
            projectId: projectRow.id,
            deletedAt: projectRow.deletedAt!.toISOString(),
          })),
      };
    },

    async recordDataRemoval(projectId, service, removedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const isDeleted = await entityManager.count(ProjectRecord, {
          id: projectId,
          deletedAt: { $ne: null },
        }) > 0;
        if (!isDeleted) return false;
        await entityManager.upsert(ProjectDataRemovalRecord, { projectId, service, removedAt });
        return true;
      });
    },

    async listDeletedProjects(limit, accessTokenLifetimeMilliseconds) {
      const entityManager = database.orm.em.fork();
      const deletedRows = await entityManager.find(
        ProjectRecord,
        { deletedAt: { $ne: null } },
        { orderBy: { deletedAt: "desc", id: "desc" }, limit },
      );
      const removalRows = deletedRows.length === 0 ? [] : await entityManager.find(
        ProjectDataRemovalRecord,
        { projectId: { $in: deletedRows.map((projectRow) => projectRow.id) } },
      );
      return deletedRows.map((projectRow) => ({
        id: projectRow.id,
        name: projectRow.name,
        deletedAt: projectRow.deletedAt!.toISOString(),
        dataRemovals: PROJECT_DATA_SERVICES.map((service) => {
          const removedAt = removalRows.find((removalRow) =>
            removalRow.projectId === projectRow.id && removalRow.service === service
          )?.removedAt;
          return {
            service,
            removedAt: removedAt?.toISOString() ?? null,
            isComplete: isRemovalFinal(
              projectRow.deletedAt!,
              removedAt,
              accessTokenLifetimeMilliseconds,
            ),
          };
        }),
      }));
    },

    async removeOwnProjectData(projectId) {
      await database.orm.em.fork().transactional(async (entityManager) => {
        await entityManager.nativeDelete(ApiKeyRecord, { projectId });
        await entityManager.nativeDelete(RoleAssignmentRecord, { projectId });
      });
    },

    async deleteProject(projectId, deletedAt) {
      const updatedCount = await database.orm.em.fork().nativeUpdate(
        ProjectRecord,
        { id: projectId, deletedAt: null },
        { deletedAt },
      );
      return updatedCount > 0;
    },

    async createApiKey(projectId, apiKey, createdAt) {
      const apiKeyRow = {
        id: generateTimeOrderedId(createdAt),
        projectId,
        ...apiKey,
        createdAt,
        revokedAt: null,
      };
      await database.orm.em.fork().insert(ApiKeyRecord, apiKeyRow);
      return toApiKey(apiKeyRow);
    },

    async listApiKeys(projectId) {
      const apiKeyRows = await database.orm.em.fork().find(
        ApiKeyRecord,
        { projectId },
        { orderBy: { createdAt: "desc", id: "desc" } },
      );
      return apiKeyRows.map(toApiKey);
    },

    async revokeApiKey(projectId, apiKeyId, revokedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const apiKeyRow = await entityManager.findOne(ApiKeyRecord, { id: apiKeyId, projectId });
        if (apiKeyRow === null) return "not_found";
        if (apiKeyRow.revokedAt) return "already_revoked";
        await entityManager.nativeUpdate(ApiKeyRecord, { id: apiKeyId }, { revokedAt });
        return "revoked";
      });
    },

    async findProjectIdByKeyHash(keyHash) {
      const entityManager = database.orm.em.fork();
      const apiKeyRow = await entityManager.findOne(ApiKeyRecord, { keyHash, revokedAt: null });
      if (apiKeyRow === null) return null;
      const projectExists = await entityManager.count(ProjectRecord, {
        id: apiKeyRow.projectId,
        deletedAt: null,
      }) > 0;
      return projectExists ? apiKeyRow.projectId : null;
    },
  };
}

function createProjectRow(name: string, createdAt: Date): ProjectRow {
  return {
    id: generateTimeOrderedId(createdAt),
    name,
    createdAt,
    deletedAt: null,
    retentionDays: DEFAULT_RETENTION_DAYS,
  };
}

/**
 * A removal is final when it happened after every access token issued before the deletion
 * expired, since such a token still lets its holder write to the Project in other services.
 */
function isRemovalFinal(
  deletedAt: Date,
  removedAt: Date | undefined,
  accessTokenLifetimeMilliseconds: number,
): boolean {
  return removedAt !== undefined &&
    removedAt.getTime() >= deletedAt.getTime() + accessTokenLifetimeMilliseconds;
}

function toProject(
  projectRow: Pick<ProjectRow, "id" | "name" | "createdAt" | "retentionDays">,
): Project {
  return {
    id: projectRow.id,
    name: projectRow.name,
    createdAt: projectRow.createdAt.toISOString(),
    retentionDays: projectRow.retentionDays,
  };
}

function toApiKey(apiKeyRow: Omit<ApiKeyRow, "keyHash">): ApiKey {
  return {
    id: apiKeyRow.id,
    projectId: apiKeyRow.projectId,
    name: apiKeyRow.name,
    keyPrefix: apiKeyRow.keyPrefix,
    createdAt: apiKeyRow.createdAt.toISOString(),
    revokedAt: apiKeyRow.revokedAt ? apiKeyRow.revokedAt.toISOString() : null,
  };
}
