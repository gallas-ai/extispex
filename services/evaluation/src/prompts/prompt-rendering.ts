import type { PromptMessage, PromptVersion, UsedPromptVersion } from "@extispex/contracts";
import type { GenerationSettings } from "../llm-providers/mod.ts";

/** The Prompt service's own pattern: `{{name}}`, optionally with spaces inside the braces. */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export type RenderedPrompt =
  | { status: "rendered"; messages: PromptMessage[] }
  | { status: "unknown_variables"; variableNames: string[] };

/** The messages a Prompt Version sends; a text prompt is one user message. */
export function readPromptMessages(promptVersion: PromptVersion): PromptMessage[] {
  return promptVersion.type === "text"
    ? [{ role: "user", content: promptVersion.text }]
    : promptVersion.messages;
}

/**
 * Replaces each Prompt Variable by its value, once: a value that itself contains `{{…}}` stays as it
 * is. A variable without a value makes the prompt unusable rather than sending it half filled.
 */
export function renderPrompt(
  messages: PromptMessage[],
  values: Record<string, string>,
): RenderedPrompt {
  const unknownNames = new Set<string>();
  const rendered = messages.map((message) => ({
    role: message.role,
    content: message.content.replace(VARIABLE_PATTERN, (placeholder, variableName: string) => {
      if (Object.hasOwn(values, variableName)) return values[variableName];
      unknownNames.add(variableName);
      return placeholder;
    }),
  }));
  return unknownNames.size > 0
    ? { status: "unknown_variables", variableNames: [...unknownNames] }
    : { status: "rendered", messages: rendered };
}

/** The Prompt Version's model parameters, with the provider's default model when it names none. */
export function readGenerationSettings(
  promptVersion: PromptVersion | null,
  defaultModel: string,
  defaultMaximumOutputTokens: number | null = null,
): GenerationSettings {
  const parameters = promptVersion?.modelParameters;
  return {
    model: parameters?.model ?? defaultModel,
    temperature: parameters?.temperature ?? null,
    maxOutputTokens: parameters?.maxOutputTokens ?? defaultMaximumOutputTokens,
    topP: parameters?.topP ?? null,
    providerOptions: parameters?.providerOptions ?? {},
  };
}

/** A copy of what the Prompt Version said, kept with the result. */
export function copyPromptVersion(promptVersion: PromptVersion): UsedPromptVersion {
  return {
    name: promptVersion.promptName,
    version: promptVersion.versionNumber,
    type: promptVersion.type,
    text: promptVersion.type === "text" ? promptVersion.text : null,
    messages: promptVersion.type === "chat" ? promptVersion.messages : null,
  };
}

/** Adds the platform's instruction to the first system message, or puts it first on its own. */
export function addSystemInstruction(
  messages: PromptMessage[],
  instruction: string,
): PromptMessage[] {
  const [firstMessage, ...laterMessages] = messages;
  if (firstMessage?.role === "system") {
    return [
      { role: "system", content: `${firstMessage.content}\n\n${instruction}` },
      ...laterMessages,
    ];
  }
  return [{ role: "system", content: instruction }, ...messages];
}
