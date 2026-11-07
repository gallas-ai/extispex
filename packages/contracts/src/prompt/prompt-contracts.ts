import { z } from "zod";

/** Letters, digits, `.`, `_` and `-`, starting with a letter or digit, so names are safe in URLs. */
const URL_SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_SAFE_NAME_MESSAGE =
  "Use letters, digits, '.', '_' and '-', starting with a letter or digit.";

/** A prompt's name, unique within its Project and never changed after creation. */
export const promptNameSchema = z.string().min(1).max(128).regex(
  URL_SAFE_NAME_PATTERN,
  URL_SAFE_NAME_MESSAGE,
);

export const promptLabelNameSchema = z.string().min(1).max(64).regex(
  URL_SAFE_NAME_PATTERN,
  URL_SAFE_NAME_MESSAGE,
);

export const promptMessageRoleSchema = z.enum(["system", "user", "assistant"]);

export const promptMessageSchema = z.object({
  role: promptMessageRoleSchema,
  content: z.string().min(1).max(100_000),
});

/**
 * Model parameters as a client sends them. The typed fields are the ones every LLM provider
 * understands; anything provider-specific goes into `providerOptions`, which is stored as given.
 * Unknown fields are rejected so that a misspelt parameter is not silently dropped.
 */
export const modelParametersInputSchema = z.strictObject({
  model: z.string().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  topP: z.number().min(0).max(1).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

/** Model parameters as stored: every typed field is present, null when not set. */
export const modelParametersSchema = z.object({
  model: z.string().nullable(),
  temperature: z.number().nullable(),
  maxOutputTokens: z.number().int().nullable(),
  topP: z.number().nullable(),
  providerOptions: z.record(z.string(), z.unknown()),
});

const promptVersionInputFields = {
  modelParameters: modelParametersInputSchema.optional(),
  commitMessage: z.string().max(500).optional(),
  /** Prompt Labels to point at the new version, created or moved. */
  labels: z.array(promptLabelNameSchema).max(20).optional(),
};

const textTemplateInputFields = {
  type: z.literal("text"),
  text: z.string().min(1).max(100_000),
};

const chatTemplateInputFields = {
  type: z.literal("chat"),
  messages: z.array(promptMessageSchema).min(1).max(100),
};

export const createPromptVersionRequestSchema = z.discriminatedUnion("type", [
  z.object({ ...textTemplateInputFields, ...promptVersionInputFields }),
  z.object({ ...chatTemplateInputFields, ...promptVersionInputFields }),
]);

const promptInputFields = {
  name: promptNameSchema,
  description: z.string().max(1_000).optional(),
};

/** Creates a prompt together with its first version, so that no prompt is ever empty. */
export const createPromptRequestSchema = z.discriminatedUnion("type", [
  z.object({ ...promptInputFields, ...textTemplateInputFields, ...promptVersionInputFields }),
  z.object({ ...promptInputFields, ...chatTemplateInputFields, ...promptVersionInputFields }),
]);

export const promptLabelSchema = z.object({
  name: z.string(),
  versionNumber: z.number().int(),
  updatedAt: z.string(),
});

export const promptSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  latestVersionNumber: z.number().int(),
  labels: z.array(promptLabelSchema),
  createdAt: z.string(),
  /** When the latest version was added. */
  updatedAt: z.string(),
});

const promptVersionFields = {
  promptName: z.string(),
  versionNumber: z.number().int(),
  modelParameters: modelParametersSchema,
  /** Names of the `{{variable}}` placeholders, in order of first appearance. */
  variables: z.array(z.string()),
  commitMessage: z.string().nullable(),
  /** Prompt Labels that currently point at this version. */
  labels: z.array(z.string()),
  createdAt: z.string(),
};

export const promptVersionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), ...promptVersionFields }),
  z.object({
    type: z.literal("chat"),
    messages: z.array(promptMessageSchema),
    ...promptVersionFields,
  }),
]);

export const promptVersionSummarySchema = z.object({
  versionNumber: z.number().int(),
  type: z.enum(["text", "chat"]),
  model: z.string().nullable(),
  variables: z.array(z.string()),
  commitMessage: z.string().nullable(),
  labels: z.array(z.string()),
  createdAt: z.string(),
});

export const listPromptsResponseSchema = z.object({ prompts: z.array(promptSummarySchema) });

export const listPromptVersionsResponseSchema = z.object({
  versions: z.array(promptVersionSummarySchema),
});

export const movePromptLabelRequestSchema = z.object({
  versionNumber: z.number().int().min(1),
});

export const comparePromptVersionsQuerySchema = z.object({
  fromVersion: z.coerce.number().int().min(1),
  toVersion: z.coerce.number().int().min(1),
});

export const changeKindSchema = z.enum(["unchanged", "changed", "added", "removed"]);

export const diffLineSchema = z.object({
  change: z.enum(["unchanged", "added", "removed"]),
  text: z.string(),
  /** Line number within the message or text in the older version, null for an added line. */
  fromLineNumber: z.number().int().nullable(),
  toLineNumber: z.number().int().nullable(),
});

/**
 * One message of a chat prompt, or the whole text of a text prompt, compared line by line.
 * Roles are null for a text prompt and on the side where the message does not exist.
 */
export const contentChangeSchema = z.object({
  change: changeKindSchema,
  fromRole: promptMessageRoleSchema.nullable(),
  toRole: promptMessageRoleSchema.nullable(),
  lines: z.array(diffLineSchema),
});

/** A typed model parameter, or `providerOptions.<key>` for a provider-specific one. */
export const modelParameterChangeSchema = z.object({
  parameter: z.string(),
  change: changeKindSchema,
  fromValue: z.unknown(),
  toValue: z.unknown(),
});

export const promptVersionComparisonSchema = z.object({
  promptName: z.string(),
  fromVersion: promptVersionSchema,
  toVersion: promptVersionSchema,
  hasChanges: z.boolean(),
  contentChanges: z.array(contentChangeSchema),
  modelParameterChanges: z.array(modelParameterChangeSchema),
});

export type PromptMessageRole = z.infer<typeof promptMessageRoleSchema>;
export type PromptMessage = z.infer<typeof promptMessageSchema>;
export type ModelParametersInput = z.infer<typeof modelParametersInputSchema>;
export type ModelParameters = z.infer<typeof modelParametersSchema>;
export type CreatePromptRequest = z.infer<typeof createPromptRequestSchema>;
export type CreatePromptVersionRequest = z.infer<typeof createPromptVersionRequestSchema>;
export type PromptLabel = z.infer<typeof promptLabelSchema>;
export type PromptSummary = z.infer<typeof promptSummarySchema>;
export type PromptVersion = z.infer<typeof promptVersionSchema>;
export type PromptVersionSummary = z.infer<typeof promptVersionSummarySchema>;
export type ListPromptsResponse = z.infer<typeof listPromptsResponseSchema>;
export type ListPromptVersionsResponse = z.infer<typeof listPromptVersionsResponseSchema>;
export type MovePromptLabelRequest = z.infer<typeof movePromptLabelRequestSchema>;
export type ChangeKind = z.infer<typeof changeKindSchema>;
export type DiffLine = z.infer<typeof diffLineSchema>;
export type ContentChange = z.infer<typeof contentChangeSchema>;
export type ModelParameterChange = z.infer<typeof modelParameterChangeSchema>;
export type PromptVersionComparison = z.infer<typeof promptVersionComparisonSchema>;
