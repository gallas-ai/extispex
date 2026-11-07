import type { ModelParameters, PromptMessage } from "@extispex/contracts";
import { defineEntity, p } from "@mikro-orm/core";

/**
 * A prompt. `latestVersionNumber` is the counter that numbers new versions: adding a version
 * increments it in the same transaction, so concurrent additions get distinct numbers.
 */
export const PromptRecord = defineEntity({
  name: "PromptRecord",
  tableName: "prompts",
  properties: {
    id: p.string().primary(),
    projectId: p.string(),
    name: p.string(),
    description: p.text(),
    latestVersionNumber: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
  uniques: [{ properties: ["projectId", "name"] }],
  indexes: [{ properties: ["projectId", "updatedAt"] }],
});

/** An immutable Prompt Version: rows are inserted and never updated. */
export const PromptVersionRecord = defineEntity({
  name: "PromptVersionRecord",
  tableName: "prompt_versions",
  properties: {
    promptId: p.string().primary(),
    versionNumber: p.integer().primary(),
    templateType: p.string(),
    text: p.text().nullable(),
    messages: p.json<PromptMessage[]>().nullable(),
    modelParameters: p.json<ModelParameters>(),
    variables: p.json<string[]>(),
    commitMessage: p.text().nullable(),
    createdAt: p.datetime(),
  },
});

export const PromptLabelRecord = defineEntity({
  name: "PromptLabelRecord",
  tableName: "prompt_labels",
  properties: {
    promptId: p.string().primary(),
    name: p.string().primary(),
    versionNumber: p.integer(),
    updatedAt: p.datetime(),
  },
});
