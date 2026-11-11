import type { Target, TargetCredential } from "@extispex/contracts";
import type { SecretCipher } from "@extispex/service-runtime";
import { type InferEntity, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import { TargetRecord } from "./evaluation-entities.ts";

type TargetRow = InferEntity<typeof TargetRecord>;

export interface StoredTarget {
  id: string;
  name: string;
}

export interface NewTarget {
  name: string;
  url: string;
  description: string;
  credential: TargetCredential | null;
}

export interface TargetChange {
  url: string;
  description: string;
  /** Undefined keeps the stored credential, and null removes it. */
  credential: TargetCredential | null | undefined;
}

export interface TargetForCalling {
  url: string;
  credential: TargetCredential | null;
}

export type CreateTargetResult = { status: "created"; created: Target } | { status: "name_taken" };

export interface TargetRepository {
  createTarget(projectId: string, target: NewTarget, createdAt: Date): Promise<CreateTargetResult>;
  listTargets(projectId: string): Promise<Target[]>;
  findTarget(projectId: string, targetName: string): Promise<StoredTarget | null>;
  readTarget(projectId: string, targetName: string): Promise<Target | null>;
  /** Null when the Target does not exist. */
  updateTarget(
    projectId: string,
    targetName: string,
    change: TargetChange,
    updatedAt: Date,
  ): Promise<Target | null>;
  /** False when the Target does not exist. */
  deleteTarget(projectId: string, targetName: string): Promise<boolean>;
  /** The worker's view, with the credential opened. Null when the Target was deleted. */
  readTargetForCalling(targetId: string): Promise<TargetForCalling | null>;
}

function toTarget(targetRow: TargetRow): Target {
  return {
    name: targetRow.name,
    url: targetRow.url,
    description: targetRow.description,
    credentialHeaderName: targetRow.credentialHeaderName ?? null,
    createdAt: targetRow.createdAt.toISOString(),
    updatedAt: targetRow.updatedAt.toISOString(),
  };
}

export function createTargetRepository(
  database: EvaluationDatabase,
  credentialCipher: SecretCipher,
): TargetRepository {
  /** Bound to the Target's ID, so that a sealed value cannot be moved to another Target. */
  const sealCredential = async (targetId: string, credential: TargetCredential | null) => ({
    credentialHeaderName: credential?.headerName ?? null,
    sealedCredentialValue: credential === null
      ? null
      : await credentialCipher.seal(credential.headerValue, targetId),
  });

  return {
    async createTarget(projectId, target, createdAt) {
      const id = crypto.randomUUID();
      const row = {
        id,
        projectId,
        name: target.name,
        url: target.url,
        description: target.description,
        ...await sealCredential(id, target.credential),
        createdAt,
        updatedAt: createdAt,
      };
      try {
        await database.orm.em.fork().insert(TargetRecord, row);
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) return { status: "name_taken" };
        throw error;
      }
      return { status: "created", created: toTarget(row as TargetRow) };
    },

    async listTargets(projectId) {
      const targetRows = await database.orm.em.fork().find(
        TargetRecord,
        { projectId },
        { orderBy: { name: "asc" } },
      );
      return targetRows.map(toTarget);
    },

    async findTarget(projectId, targetName) {
      const targetRow = await database.orm.em.fork().findOne(TargetRecord, {
        projectId,
        name: targetName,
      });
      return targetRow === null ? null : { id: targetRow.id, name: targetRow.name };
    },

    async readTarget(projectId, targetName) {
      const targetRow = await database.orm.em.fork().findOne(TargetRecord, {
        projectId,
        name: targetName,
      });
      return targetRow === null ? null : toTarget(targetRow);
    },

    async updateTarget(projectId, targetName, change, updatedAt) {
      const entityManager = database.orm.em.fork();
      const existing = await entityManager.findOne(TargetRecord, { projectId, name: targetName });
      if (existing === null) return null;
      await entityManager.nativeUpdate(TargetRecord, { id: existing.id }, {
        url: change.url,
        description: change.description,
        ...(change.credential === undefined
          ? {}
          : await sealCredential(existing.id, change.credential)),
        updatedAt,
      });
      return toTarget(
        await entityManager.findOneOrFail(TargetRecord, { id: existing.id }, { refresh: true }),
      );
    },

    async deleteTarget(projectId, targetName) {
      const deletedCount = await database.orm.em.fork().nativeDelete(TargetRecord, {
        projectId,
        name: targetName,
      });
      return deletedCount > 0;
    },

    async readTargetForCalling(targetId) {
      const targetRow = await database.orm.em.fork().findOne(TargetRecord, { id: targetId });
      if (targetRow === null) return null;
      const { credentialHeaderName, sealedCredentialValue } = targetRow;
      return {
        url: targetRow.url,
        credential: credentialHeaderName == null || sealedCredentialValue == null ? null : {
          headerName: credentialHeaderName,
          headerValue: await credentialCipher.open(sealedCredentialValue, targetId),
        },
      };
    },
  };
}
