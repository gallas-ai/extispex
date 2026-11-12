import { z } from "zod";
import { promptNameSchema } from "../prompt/prompt-contracts.ts";

/** Letters, digits, `.`, `_` and `-`, starting with a letter or digit, so names are safe in URLs. */
const URL_SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_SAFE_NAME_MESSAGE =
  "Use letters, digits, '.', '_' and '-', starting with a letter or digit.";

/** An LLM provider's name, unique within its Project. */
export const llmProviderNameSchema = z.string().min(1).max(128).regex(
  URL_SAFE_NAME_PATTERN,
  URL_SAFE_NAME_MESSAGE,
);

/**
 * How Evaluation talks to the provider. `openai_compatible` covers OpenAI, Azure OpenAI's v1 API
 * and local servers such as vLLM or Ollama; `typesafe` is TypeSafe's System One API with Jev.
 */
export const llmProviderKindSchema = z.enum(["openai_compatible", "anthropic", "typesafe"]);

/**
 * What a provider can do: produce free-form text from a prompt, or answer a typed question about
 * a given state with a structured decision.
 */
export const llmProviderCapabilitySchema = z.enum(["text_generation", "judgment"]);

export type LlmProviderKind = z.infer<typeof llmProviderKindSchema>;
export type LlmProviderCapability = z.infer<typeof llmProviderCapabilitySchema>;

/** Each kind declares its capabilities: Jev answers typed questions and writes no free text. */
export const LLM_PROVIDER_CAPABILITIES: Record<LlmProviderKind, LlmProviderCapability[]> = {
  openai_compatible: ["text_generation"],
  anthropic: ["text_generation"],
  typesafe: ["judgment"],
};

/** Where a provider is reached when its base URL is left out. */
export const DEFAULT_LLM_PROVIDER_BASE_URLS: Record<LlmProviderKind, string> = {
  openai_compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  typesafe: "https://api.typesafe.ai",
};

/** Kinds that cannot be called without an API key. A local model often needs none. */
export const LLM_PROVIDER_KINDS_REQUIRING_API_KEY: LlmProviderKind[] = ["anthropic", "typesafe"];

const providerBaseUrlSchema = z.string().min(1).max(2_048).refine((url) => {
  if (!URL.canParse(url)) return false;
  const { protocol, username, password, search, hash } = new URL(url);
  return (protocol === "http:" || protocol === "https:") && username === "" && password === "" &&
    search === "" && hash === "";
}, "Use an http or https URL without a user name, password, query or fragment.");

const providerApiKeySchema = z.string().min(1).max(8_192).regex(
  /^[\x21-\x7e]+$/,
  "An API key cannot contain spaces, line breaks or other control characters.",
);

const modelNameSchema = z.string().min(1).max(200);

export const createLlmProviderRequestSchema = z.strictObject({
  name: llmProviderNameSchema,
  kind: llmProviderKindSchema,
  /** The kind's public address when left out. */
  baseUrl: providerBaseUrlSchema.optional(),
  /** Stored encrypted and never returned. */
  apiKey: providerApiKeySchema.optional(),
  /** Used when a Prompt Version names no model, and always for a Judgment provider. */
  defaultModel: modelNameSchema,
  description: z.string().max(2_000).optional(),
}).superRefine((request, context) => {
  if (LLM_PROVIDER_KINDS_REQUIRING_API_KEY.includes(request.kind) && request.apiKey === undefined) {
    context.addIssue({
      code: "custom",
      message: "This kind of provider needs an API key.",
      path: ["apiKey"],
    });
  }
});

/** Leaving `apiKey` out keeps the stored key, and `null` removes it. */
export const updateLlmProviderRequestSchema = z.strictObject({
  baseUrl: providerBaseUrlSchema,
  defaultModel: modelNameSchema,
  description: z.string().max(2_000).optional(),
  apiKey: providerApiKeySchema.nullable().optional(),
});

export const llmProviderSchema = z.object({
  name: llmProviderNameSchema,
  kind: llmProviderKindSchema,
  capabilities: z.array(llmProviderCapabilitySchema),
  baseUrl: z.string(),
  defaultModel: z.string(),
  description: z.string(),
  /** Whether an API key is stored. The key itself is never returned. */
  hasApiKey: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listLlmProvidersResponseSchema = z.object({
  llmProviders: z.array(llmProviderSchema),
});

/** One Prompt Version, by number, so that a run can be repeated with exactly the same prompt. */
export const promptVersionReferenceSchema = z.strictObject({
  name: promptNameSchema,
  version: z.number().int().min(1),
});

/**
 * Which provider writes each finished run's LLM Summary, and with which prompt. Without a prompt,
 * the built-in default is used; without a provider, runs get no LLM Summary.
 */
export const updateLlmSummarySettingsRequestSchema = z.strictObject({
  providerName: llmProviderNameSchema.nullable(),
  prompt: promptVersionReferenceSchema.nullable().default(null),
});

export const llmSummarySettingsSchema = z.object({
  providerName: z.string().nullable(),
  prompt: promptVersionReferenceSchema.nullable(),
  /** Null until the settings were first saved. */
  updatedAt: z.string().nullable(),
});

/**
 * A run's LLM Summary. `pending` until the worker has written it; `not_configured` when the
 * Project had no LLM Summary provider when the run finished.
 */
export const llmSummaryStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "not_configured",
]);

export const llmSummarySchema = z.object({
  status: llmSummaryStatusSchema,
  text: z.string().nullable(),
  /** Why the LLM Summary could not be written. */
  error: z.string().nullable(),
  providerName: z.string().nullable(),
  /** The model that wrote it, as the provider named it. */
  model: z.string().nullable(),
  /** The user's Prompt Version, or null for the default prompt. */
  prompt: promptVersionReferenceSchema.nullable(),
  generatedAt: z.string().nullable(),
});

export type CreateLlmProviderRequest = z.input<typeof createLlmProviderRequestSchema>;
export type UpdateLlmProviderRequest = z.input<typeof updateLlmProviderRequestSchema>;
export type LlmProvider = z.infer<typeof llmProviderSchema>;
export type ListLlmProvidersResponse = z.infer<typeof listLlmProvidersResponseSchema>;
export type PromptVersionReference = z.infer<typeof promptVersionReferenceSchema>;
export type UpdateLlmSummarySettingsRequest = z.input<
  typeof updateLlmSummarySettingsRequestSchema
>;
export type LlmSummarySettings = z.infer<typeof llmSummarySettingsSchema>;
export type LlmSummaryStatus = z.infer<typeof llmSummaryStatusSchema>;
export type LlmSummary = z.infer<typeof llmSummarySchema>;
