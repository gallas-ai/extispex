import type {
  CreatePromptVersionRequest,
  ModelParameters,
  ModelParametersInput,
  PromptMessage,
} from "@extispex/contracts";

/** A prompt's template: one text, or a list of chat messages. */
export type PromptTemplate =
  | { type: "text"; text: string }
  | { type: "chat"; messages: PromptMessage[] };

/** Everything needed to store a new Prompt Version, before it has a number. */
export interface NewPromptVersion {
  template: PromptTemplate;
  modelParameters: ModelParameters;
  variables: string[];
  commitMessage: string | null;
  /** Prompt Labels to point at the new version. */
  labelNames: string[];
}

/**
 * Placeholders are `{{name}}`, optionally with spaces inside the braces. They are only ever
 * replaced by values: there are no conditions or loops, so a template cannot run logic.
 */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function createNewPromptVersion(request: CreatePromptVersionRequest): NewPromptVersion {
  const template: PromptTemplate = request.type === "text"
    ? { type: "text", text: request.text }
    : { type: "chat", messages: request.messages };
  return {
    template,
    modelParameters: normalizeModelParameters(request.modelParameters),
    variables: extractTemplateVariables(template),
    commitMessage: request.commitMessage?.trim() || null,
    labelNames: [...new Set(request.labels ?? [])],
  };
}

export function normalizeModelParameters(input: ModelParametersInput = {}): ModelParameters {
  return {
    model: input.model ?? null,
    temperature: input.temperature ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    topP: input.topP ?? null,
    providerOptions: input.providerOptions ?? {},
  };
}

/** Variable names in order of first appearance, each listed once. */
export function extractTemplateVariables(template: PromptTemplate): string[] {
  const texts = template.type === "text"
    ? [template.text]
    : template.messages.map((message) => message.content);
  const variableNames = new Set<string>();
  for (const text of texts) {
    for (const variableMatch of text.matchAll(VARIABLE_PATTERN)) {
      variableNames.add(variableMatch[1]);
    }
  }
  return [...variableNames];
}
