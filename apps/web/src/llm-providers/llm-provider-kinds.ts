import type { LlmProviderKind } from "@extispex/contracts";

/** Kept here so that the UI bundle does not load the schemas. */
export const LLM_PROVIDER_KIND_LABELS: Record<LlmProviderKind, string> = {
  openai_compatible: "OpenAI-compatible",
  anthropic: "Anthropic",
  typesafe: "TypeSafe Jev",
};

export const DEFAULT_BASE_URLS: Record<LlmProviderKind, string> = {
  openai_compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  typesafe: "https://api.typesafe.ai",
};

export const DEFAULT_MODELS: Record<LlmProviderKind, string> = {
  openai_compatible: "gpt-4.1-mini",
  anthropic: "claude-opus-5-5",
  typesafe: "jev-latest",
};

export const KIND_HINTS: Record<LlmProviderKind, string> = {
  openai_compatible:
    "OpenAI, Azure OpenAI's v1 API or a local server such as vLLM or Ollama. Follows Prompt Versions.",
  anthropic: "Claude through Anthropic's Messages API. Follows Prompt Versions.",
  typesafe: "Answers typed questions about the Transcript with probabilities; writes no free text.",
};

export const CAPABILITY_LABELS = {
  text_generation: "Text Generation",
  judgment: "Judgment",
} as const;

export function llmProviderPagePath(providerName: string): string {
  return `/llm-providers/${encodeURIComponent(providerName)}`;
}
