import {
  LLM_PROVIDER_CAPABILITIES,
  LLM_PROVIDER_KINDS_REQUIRING_API_KEY,
  type LlmProvider,
  type LlmProviderKind,
  type LlmSummarySettings,
  type PromptVersionReference,
} from "@extispex/contracts";
import type { SecretCipher } from "@extispex/service-runtime";
import { type InferEntity, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import { LlmProviderRecord, LlmSummarySettingsRecord } from "./evaluation-entities.ts";

type LlmProviderRow = InferEntity<typeof LlmProviderRecord>;

export interface NewLlmProvider {
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
  defaultModel: string;
  description: string;
  apiKey: string | null;
}

export interface LlmProviderChange {
  baseUrl: string;
  defaultModel: string;
  description: string;
  /** Undefined keeps the stored key, and null removes it. */
  apiKey: string | null | undefined;
}

/** What the worker needs to call a provider, with the API key opened. */
export interface LlmProviderConnection {
  id: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
  defaultModel: string;
  apiKey: string | null;
}

export type CreateLlmProviderResult =
  | { status: "created"; created: LlmProvider }
  | { status: "name_taken" };

export type UpdateLlmProviderResult =
  | { status: "updated"; updated: LlmProvider }
  | { status: "not_found" }
  | { status: "api_key_required" };

export type UpdateLlmSummarySettingsResult =
  | { status: "updated"; settings: LlmSummarySettings }
  | { status: "unknown_provider" }
  | { status: "no_text_generation" };

export interface LlmProviderRepository {
  createProvider(
    projectId: string,
    provider: NewLlmProvider,
    createdAt: Date,
  ): Promise<CreateLlmProviderResult>;
  listProviders(projectId: string): Promise<LlmProvider[]>;
  readProvider(projectId: string, providerName: string): Promise<LlmProvider | null>;
  updateProvider(
    projectId: string,
    providerName: string,
    change: LlmProviderChange,
    updatedAt: Date,
  ): Promise<UpdateLlmProviderResult>;
  /** False when the provider does not exist. LLM Summaries stop using a deleted provider. */
  deleteProvider(projectId: string, providerName: string): Promise<boolean>;
  /** The worker's view, by name within the Project. Null when there is no such provider. */
  findProviderForCalling(
    projectId: string,
    providerName: string,
  ): Promise<LlmProviderConnection | null>;
  /** The worker's view, by ID. Null when the provider was deleted. */
  readProviderForCalling(providerId: string): Promise<LlmProviderConnection | null>;
  readSummarySettings(projectId: string): Promise<LlmSummarySettings>;
  updateSummarySettings(
    projectId: string,
    settings: { providerName: string | null; prompt: PromptVersionReference | null },
    updatedAt: Date,
  ): Promise<UpdateLlmSummarySettingsResult>;
}

function toLlmProvider(providerRow: LlmProviderRow): LlmProvider {
  return {
    name: providerRow.name,
    kind: providerRow.kind,
    capabilities: LLM_PROVIDER_CAPABILITIES[providerRow.kind],
    baseUrl: providerRow.baseUrl,
    defaultModel: providerRow.defaultModel,
    description: providerRow.description,
    hasApiKey: providerRow.sealedApiKey != null,
    createdAt: providerRow.createdAt.toISOString(),
    updatedAt: providerRow.updatedAt.toISOString(),
  };
}

export function createLlmProviderRepository(
  database: EvaluationDatabase,
  apiKeyCipher: SecretCipher,
): LlmProviderRepository {
  /** Bound to the provider's ID, so that a sealed key cannot be moved to another provider. */
  const sealApiKey = async (providerId: string, apiKey: string | null) =>
    apiKey === null ? null : await apiKeyCipher.seal(apiKey, providerId);

  const toConnection = async (providerRow: LlmProviderRow): Promise<LlmProviderConnection> => ({
    id: providerRow.id,
    name: providerRow.name,
    kind: providerRow.kind,
    baseUrl: providerRow.baseUrl,
    defaultModel: providerRow.defaultModel,
    apiKey: providerRow.sealedApiKey == null
      ? null
      : await apiKeyCipher.open(providerRow.sealedApiKey, providerRow.id),
  });

  return {
    async createProvider(projectId, provider, createdAt) {
      const id = crypto.randomUUID();
      const row = {
        id,
        projectId,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        description: provider.description,
        sealedApiKey: await sealApiKey(id, provider.apiKey),
        createdAt,
        updatedAt: createdAt,
      };
      try {
        await database.orm.em.fork().insert(LlmProviderRecord, row);
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) return { status: "name_taken" };
        throw error;
      }
      return { status: "created", created: toLlmProvider(row as LlmProviderRow) };
    },

    async listProviders(projectId) {
      const providerRows = await database.orm.em.fork().find(
        LlmProviderRecord,
        { projectId },
        { orderBy: { name: "asc" } },
      );
      return providerRows.map(toLlmProvider);
    },

    async readProvider(projectId, providerName) {
      const providerRow = await database.orm.em.fork().findOne(LlmProviderRecord, {
        projectId,
        name: providerName,
      });
      return providerRow === null ? null : toLlmProvider(providerRow);
    },

    async updateProvider(projectId, providerName, change, updatedAt) {
      const entityManager = database.orm.em.fork();
      const existing = await entityManager.findOne(LlmProviderRecord, {
        projectId,
        name: providerName,
      });
      if (existing === null) return { status: "not_found" };
      const willHaveApiKey = change.apiKey === undefined
        ? existing.sealedApiKey != null
        : change.apiKey !== null;
      if (LLM_PROVIDER_KINDS_REQUIRING_API_KEY.includes(existing.kind) && !willHaveApiKey) {
        return { status: "api_key_required" };
      }
      await entityManager.nativeUpdate(LlmProviderRecord, { id: existing.id }, {
        baseUrl: change.baseUrl,
        defaultModel: change.defaultModel,
        description: change.description,
        ...(change.apiKey === undefined
          ? {}
          : { sealedApiKey: await sealApiKey(existing.id, change.apiKey) }),
        updatedAt,
      });
      return {
        status: "updated",
        updated: toLlmProvider(
          await entityManager.findOneOrFail(LlmProviderRecord, { id: existing.id }, {
            refresh: true,
          }),
        ),
      };
    },

    async deleteProvider(projectId, providerName) {
      return await database.orm.em.fork().transactional(async (entityManager) => {
        const existing = await entityManager.findOne(LlmProviderRecord, {
          projectId,
          name: providerName,
        });
        if (existing === null) return false;
        await entityManager.nativeDelete(LlmProviderRecord, { id: existing.id });
        await entityManager.nativeUpdate(LlmSummarySettingsRecord, {
          projectId,
          providerId: existing.id,
        }, { providerId: null });
        return true;
      });
    },

    async findProviderForCalling(projectId, providerName) {
      const providerRow = await database.orm.em.fork().findOne(LlmProviderRecord, {
        projectId,
        name: providerName,
      });
      return providerRow === null ? null : await toConnection(providerRow);
    },

    async readProviderForCalling(providerId) {
      const providerRow = await database.orm.em.fork().findOne(LlmProviderRecord, {
        id: providerId,
      });
      return providerRow === null ? null : await toConnection(providerRow);
    },

    async readSummarySettings(projectId) {
      const entityManager = database.orm.em.fork();
      const settingsRow = await entityManager.findOne(LlmSummarySettingsRecord, { projectId });
      if (settingsRow === null) return { providerName: null, prompt: null, updatedAt: null };
      const providerRow = settingsRow.providerId == null
        ? null
        : await entityManager.findOne(LlmProviderRecord, { id: settingsRow.providerId });
      return {
        providerName: providerRow?.name ?? null,
        prompt: settingsRow.promptName == null || settingsRow.promptVersion == null
          ? null
          : { name: settingsRow.promptName, version: settingsRow.promptVersion },
        updatedAt: settingsRow.updatedAt.toISOString(),
      };
    },

    async updateSummarySettings(projectId, { providerName, prompt }, updatedAt) {
      const entityManager = database.orm.em.fork();
      const providerRow = providerName === null
        ? null
        : await entityManager.findOne(LlmProviderRecord, { projectId, name: providerName });
      if (providerName !== null && providerRow === null) return { status: "unknown_provider" };
      if (
        providerRow !== null &&
        !LLM_PROVIDER_CAPABILITIES[providerRow.kind].includes("text_generation")
      ) {
        return { status: "no_text_generation" };
      }
      await entityManager.upsert(LlmSummarySettingsRecord, {
        projectId,
        providerId: providerRow?.id ?? null,
        promptName: prompt?.name ?? null,
        promptVersion: prompt?.version ?? null,
        updatedAt,
      });
      return {
        status: "updated",
        settings: {
          providerName: providerRow?.name ?? null,
          prompt,
          updatedAt: updatedAt.toISOString(),
        },
      };
    },
  };
}
