import type {
  CreatePromptVersionRequest,
  ModelParametersInput,
  PromptMessageRole,
  PromptVersion,
} from "@extispex/contracts";

/** What the prompt editor holds: every field as typed, before it is checked. */
export interface PromptDraft {
  type: "text" | "chat";
  text: string;
  messages: { role: PromptMessageRole; content: string }[];
  model: string;
  temperature: string;
  maxOutputTokens: string;
  topP: string;
  providerOptionsJson: string;
  commitMessage: string;
  /** Prompt Label names separated by commas or spaces. */
  labelNames: string;
}

export type DraftCheck =
  | { isValid: true; request: CreatePromptVersionRequest }
  | { isValid: false; problem: string };

/** The same placeholder rule as the Prompt service, so the editor shows what will be detected. */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function createEmptyDraft(): PromptDraft {
  return {
    type: "chat",
    text: "",
    messages: [{ role: "system", content: "" }, { role: "user", content: "" }],
    model: "",
    temperature: "",
    maxOutputTokens: "",
    topP: "",
    providerOptionsJson: "",
    commitMessage: "",
    labelNames: "",
  };
}

/** A draft that starts from an existing version, for adding the next one. Labels are not copied. */
export function createDraftFromVersion(version: PromptVersion): PromptDraft {
  const { modelParameters } = version;
  return {
    ...createEmptyDraft(),
    type: version.type,
    text: version.type === "text" ? version.text : "",
    messages: version.type === "chat"
      ? version.messages.map((message) => ({ ...message }))
      : createEmptyDraft().messages,
    model: modelParameters.model ?? "",
    temperature: modelParameters.temperature?.toString() ?? "",
    maxOutputTokens: modelParameters.maxOutputTokens?.toString() ?? "",
    topP: modelParameters.topP?.toString() ?? "",
    providerOptionsJson: Object.keys(modelParameters.providerOptions).length === 0
      ? ""
      : JSON.stringify(modelParameters.providerOptions, null, 2),
  };
}

export function findDraftVariables(draft: PromptDraft): string[] {
  const texts = draft.type === "text"
    ? [draft.text]
    : draft.messages.map((message) => message.content);
  const variableNames = new Set<string>();
  for (const text of texts) {
    for (const variableMatch of text.matchAll(VARIABLE_PATTERN)) {
      variableNames.add(variableMatch[1]);
    }
  }
  return [...variableNames];
}

export function splitLabelNames(labelNames: string): string[] {
  return [...new Set(labelNames.split(/[\s,]+/).filter(Boolean))];
}

/**
 * Turns the draft into an API request, catching what the form can check itself. Everything else,
 * such as a label name with spaces, is left to the API, whose message the editor then shows.
 */
export function checkDraft(draft: PromptDraft): DraftCheck {
  if (draft.type === "text" && draft.text.trim() === "") {
    return { isValid: false, problem: "Write the prompt text." };
  }
  if (draft.type === "chat") {
    if (draft.messages.length === 0) {
      return { isValid: false, problem: "Add at least one message." };
    }
    const emptyMessageIndex = draft.messages.findIndex((message) => message.content.trim() === "");
    if (emptyMessageIndex !== -1) {
      return { isValid: false, problem: `Message ${emptyMessageIndex + 1} is empty.` };
    }
  }
  const modelParameters: ModelParametersInput = {};
  if (draft.model.trim() !== "") modelParameters.model = draft.model.trim();
  for (
    const [field, label] of [
      ["temperature", "Temperature"],
      ["maxOutputTokens", "Max output tokens"],
      ["topP", "Top P"],
    ] as const
  ) {
    const typedValue = draft[field].trim();
    if (typedValue === "") continue;
    const numericValue = Number(typedValue);
    if (!Number.isFinite(numericValue)) {
      return { isValid: false, problem: `${label} must be a number.` };
    }
    modelParameters[field] = numericValue;
  }
  if (draft.providerOptionsJson.trim() !== "") {
    let providerOptions: unknown;
    try {
      providerOptions = JSON.parse(draft.providerOptionsJson);
    } catch {
      return { isValid: false, problem: "Provider options must be valid JSON." };
    }
    if (
      providerOptions === null || typeof providerOptions !== "object" ||
      Array.isArray(providerOptions)
    ) {
      return { isValid: false, problem: "Provider options must be a JSON object." };
    }
    modelParameters.providerOptions = providerOptions as Record<string, unknown>;
  }
  const sharedFields = {
    modelParameters,
    commitMessage: draft.commitMessage.trim() || undefined,
    labels: splitLabelNames(draft.labelNames),
  };
  return {
    isValid: true,
    request: draft.type === "text" ? { type: "text", text: draft.text, ...sharedFields } : {
      type: "chat",
      messages: draft.messages.map((message) => ({ ...message })),
      ...sharedFields,
    },
  };
}
