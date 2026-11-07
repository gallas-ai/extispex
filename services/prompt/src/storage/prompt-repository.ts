import type {
  PromptLabel,
  PromptSummary,
  PromptVersion,
  PromptVersionSummary,
} from "@extispex/contracts";
import { type InferEntity, raw, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/sql";
import type { NewPromptVersion } from "../prompts/prompt-versions.ts";
import type { PromptDatabase } from "./prompt-database.ts";
import { PromptLabelRecord, PromptRecord, PromptVersionRecord } from "./prompt-entities.ts";

/** A prompt found by name within a Project, identified internally by its ID. */
export interface StoredPrompt {
  id: string;
  name: string;
}

export interface NewPrompt {
  name: string;
  description: string;
}

export type CreatePromptResult =
  | { status: "created"; version: PromptVersion }
  | { status: "name_taken" };

export interface PromptRepository {
  /** Creates the prompt and its version 1 in one transaction. */
  createPrompt(
    projectId: string,
    prompt: NewPrompt,
    firstVersion: NewPromptVersion,
    createdAt: Date,
  ): Promise<CreatePromptResult>;
  listPrompts(projectId: string): Promise<PromptSummary[]>;
  findPrompt(projectId: string, promptName: string): Promise<StoredPrompt | null>;
  readPromptSummary(prompt: StoredPrompt): Promise<PromptSummary>;
  addVersion(
    prompt: StoredPrompt,
    version: NewPromptVersion,
    createdAt: Date,
  ): Promise<PromptVersion>;
  /** Newest first. */
  listVersions(prompt: StoredPrompt): Promise<PromptVersionSummary[]>;
  findVersion(prompt: StoredPrompt, versionNumber: number): Promise<PromptVersion | null>;
  findVersionByLabel(prompt: StoredPrompt, labelName: string): Promise<PromptVersion | null>;
  /** Creates or moves the label; null when the version does not exist. */
  moveLabel(
    prompt: StoredPrompt,
    labelName: string,
    versionNumber: number,
    updatedAt: Date,
  ): Promise<PromptLabel | null>;
  /** False when the label does not exist. */
  removeLabel(prompt: StoredPrompt, labelName: string): Promise<boolean>;
}

type PromptVersionRow = InferEntity<typeof PromptVersionRecord>;
type PromptLabelRow = InferEntity<typeof PromptLabelRecord>;
type PromptRow = InferEntity<typeof PromptRecord>;

export function createPromptRepository(database: PromptDatabase): PromptRepository {
  const findVersionRow = async (
    entityManager: EntityManager,
    prompt: StoredPrompt,
    versionNumber: number,
  ): Promise<PromptVersion | null> => {
    const versionRow = await entityManager.findOne(PromptVersionRecord, {
      promptId: prompt.id,
      versionNumber,
    });
    if (versionRow === null) return null;
    const labelRows = await entityManager.find(PromptLabelRecord, {
      promptId: prompt.id,
      versionNumber,
    });
    return toPromptVersion(prompt.name, versionRow, labelRows);
  };

  return {
    async createPrompt(projectId, prompt, firstVersion, createdAt) {
      const promptId = crypto.randomUUID();
      try {
        await database.orm.em.fork().transactional(async (entityManager) => {
          await entityManager.insert(PromptRecord, {
            id: promptId,
            projectId,
            name: prompt.name,
            description: prompt.description,
            latestVersionNumber: 1,
            createdAt,
            updatedAt: createdAt,
          });
          await insertVersion(entityManager, promptId, 1, firstVersion, createdAt);
        });
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) {
          return { status: "name_taken" };
        }
        throw error;
      }
      const version = await findVersionRow(
        database.orm.em.fork(),
        { id: promptId, name: prompt.name },
        1,
      );
      return { status: "created", version: version as PromptVersion };
    },

    async listPrompts(projectId) {
      const entityManager = database.orm.em.fork();
      const promptRows = await entityManager.find(
        PromptRecord,
        { projectId },
        { orderBy: { updatedAt: "desc", name: "asc" } },
      );
      if (promptRows.length === 0) return [];
      const labelRows = await entityManager.find(
        PromptLabelRecord,
        { promptId: { $in: promptRows.map((promptRow) => promptRow.id) } },
        { orderBy: { name: "asc" } },
      );
      return promptRows.map((promptRow) =>
        toPromptSummary(
          promptRow,
          labelRows.filter((labelRow) => labelRow.promptId === promptRow.id),
        )
      );
    },

    async findPrompt(projectId, promptName) {
      const promptRow = await database.orm.em.fork().findOne(PromptRecord, {
        projectId,
        name: promptName,
      });
      return promptRow === null ? null : { id: promptRow.id, name: promptRow.name };
    },

    async readPromptSummary(prompt) {
      const entityManager = database.orm.em.fork();
      const promptRow = await entityManager.findOneOrFail(PromptRecord, { id: prompt.id });
      const labelRows = await entityManager.find(
        PromptLabelRecord,
        { promptId: prompt.id },
        { orderBy: { name: "asc" } },
      );
      return toPromptSummary(promptRow, labelRows);
    },

    async addVersion(prompt, version, createdAt) {
      const versionNumber = await database.orm.em.fork().transactional(async (entityManager) => {
        // The increment locks the prompt's row until commit, so concurrent additions queue up.
        await entityManager.nativeUpdate(PromptRecord, { id: prompt.id }, {
          latestVersionNumber: raw("latest_version_number + 1"),
          updatedAt: createdAt,
        });
        const promptRow = await entityManager.findOneOrFail(
          PromptRecord,
          { id: prompt.id },
          { refresh: true },
        );
        await insertVersion(
          entityManager,
          prompt.id,
          promptRow.latestVersionNumber,
          version,
          createdAt,
        );
        return promptRow.latestVersionNumber;
      });
      return await findVersionRow(database.orm.em.fork(), prompt, versionNumber) as PromptVersion;
    },

    async listVersions(prompt) {
      const entityManager = database.orm.em.fork();
      const versionRows = await entityManager.find(
        PromptVersionRecord,
        { promptId: prompt.id },
        { orderBy: { versionNumber: "desc" } },
      );
      const labelRows = await entityManager.find(
        PromptLabelRecord,
        { promptId: prompt.id },
        { orderBy: { name: "asc" } },
      );
      return versionRows.map((versionRow) => ({
        versionNumber: versionRow.versionNumber,
        type: versionRow.templateType as PromptVersionSummary["type"],
        model: versionRow.modelParameters.model,
        variables: versionRow.variables,
        commitMessage: versionRow.commitMessage ?? null,
        labels: labelRows
          .filter((labelRow) => labelRow.versionNumber === versionRow.versionNumber)
          .map((labelRow) => labelRow.name),
        createdAt: versionRow.createdAt.toISOString(),
      }));
    },

    findVersion(prompt, versionNumber) {
      return findVersionRow(database.orm.em.fork(), prompt, versionNumber);
    },

    async findVersionByLabel(prompt, labelName) {
      const entityManager = database.orm.em.fork();
      const labelRow = await entityManager.findOne(PromptLabelRecord, {
        promptId: prompt.id,
        name: labelName,
      });
      if (labelRow === null) return null;
      return await findVersionRow(entityManager, prompt, labelRow.versionNumber);
    },

    async moveLabel(prompt, labelName, versionNumber, updatedAt) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const versionExists = await entityManager.count(PromptVersionRecord, {
          promptId: prompt.id,
          versionNumber,
        }) > 0;
        if (!versionExists) return null;
        await upsertLabels(entityManager, prompt.id, [labelName], versionNumber, updatedAt);
        return { name: labelName, versionNumber, updatedAt: updatedAt.toISOString() };
      });
    },

    async removeLabel(prompt, labelName) {
      const removedCount = await database.orm.em.fork().nativeDelete(PromptLabelRecord, {
        promptId: prompt.id,
        name: labelName,
      });
      return removedCount > 0;
    },
  };
}

async function insertVersion(
  entityManager: EntityManager,
  promptId: string,
  versionNumber: number,
  version: NewPromptVersion,
  createdAt: Date,
): Promise<void> {
  await entityManager.insert(PromptVersionRecord, {
    promptId,
    versionNumber,
    templateType: version.template.type,
    text: version.template.type === "text" ? version.template.text : null,
    messages: version.template.type === "chat" ? version.template.messages : null,
    modelParameters: version.modelParameters,
    variables: version.variables,
    commitMessage: version.commitMessage,
    createdAt,
  });
  await upsertLabels(entityManager, promptId, version.labelNames, versionNumber, createdAt);
}

async function upsertLabels(
  entityManager: EntityManager,
  promptId: string,
  labelNames: string[],
  versionNumber: number,
  updatedAt: Date,
): Promise<void> {
  if (labelNames.length === 0) return;
  await entityManager.createQueryBuilder(PromptLabelRecord)
    .insert(labelNames.map((name) => ({ promptId, name, versionNumber, updatedAt })))
    .onConflict(["promptId", "name"])
    .merge(["versionNumber", "updatedAt"])
    .execute();
}

function toPromptSummary(promptRow: PromptRow, labelRows: PromptLabelRow[]): PromptSummary {
  return {
    name: promptRow.name,
    description: promptRow.description,
    latestVersionNumber: promptRow.latestVersionNumber,
    labels: labelRows.map(toPromptLabel),
    createdAt: promptRow.createdAt.toISOString(),
    updatedAt: promptRow.updatedAt.toISOString(),
  };
}

function toPromptLabel(labelRow: PromptLabelRow): PromptLabel {
  return {
    name: labelRow.name,
    versionNumber: labelRow.versionNumber,
    updatedAt: labelRow.updatedAt.toISOString(),
  };
}

function toPromptVersion(
  promptName: string,
  versionRow: PromptVersionRow,
  labelRows: PromptLabelRow[],
): PromptVersion {
  const sharedFields = {
    promptName,
    versionNumber: versionRow.versionNumber,
    modelParameters: versionRow.modelParameters,
    variables: versionRow.variables,
    commitMessage: versionRow.commitMessage ?? null,
    labels: labelRows.map((labelRow) => labelRow.name).sort(),
    createdAt: versionRow.createdAt.toISOString(),
  };
  return versionRow.templateType === "text"
    ? { type: "text", text: versionRow.text ?? "", ...sharedFields }
    : { type: "chat", messages: versionRow.messages ?? [], ...sharedFields };
}
