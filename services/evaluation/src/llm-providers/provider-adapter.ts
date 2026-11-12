import type { JudgmentQuestion, LlmProviderCapability, PromptMessage } from "@extispex/contracts";

/** The model parameters of a Prompt Version, with the model always chosen. */
export interface GenerationSettings {
  model: string;
  temperature: number | null;
  maxOutputTokens: number | null;
  topP: number | null;
  /** Sent to the provider as given, alongside the typed fields. */
  providerOptions: Record<string, unknown>;
}

/** A JSON Schema the answer must follow, enforced by the provider where it can. */
export interface ResponseFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface TextGenerationRequest {
  messages: PromptMessage[];
  settings: GenerationSettings;
  /** With a format, the answer is JSON text that follows it. */
  responseFormat?: ResponseFormat;
}

export interface JudgmentRequest {
  /** The content the question is about, as JSON. */
  state: unknown;
  question: JudgmentQuestion;
  model: string;
}

/** A Judgment provider's typed answer. Probabilities are keyed by choice or by level. */
export type JudgmentAnswer =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

/** Where and what to send. The caller adds the timeout, the allowlist and the retries. */
export interface ProviderHttpRequest {
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type ParsedAnswer<Value> =
  | { status: "answered"; value: Value; model: string | null }
  | { status: "error"; reason: string };

/** The connection details the adapters need. */
export interface ProviderEndpoint {
  baseUrl: string;
  apiKey: string | null;
}

/** One kind of provider: how its requests look and how its answers are read. */
export interface ProviderAdapter {
  capabilities: LlmProviderCapability[];
  buildTextRequest?(
    endpoint: ProviderEndpoint,
    request: TextGenerationRequest,
  ): ProviderHttpRequest;
  parseTextResponse?(body: unknown, request: TextGenerationRequest): ParsedAnswer<string>;
  buildJudgmentRequest?(endpoint: ProviderEndpoint, request: JudgmentRequest): ProviderHttpRequest;
  parseJudgmentResponse?(body: unknown, request: JudgmentRequest): ParsedAnswer<JudgmentAnswer>;
}

/** `https://host/v1` and `https://host/v1/` both become `https://host/v1/<path>`. */
export function joinUrl(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/${path}`);
}

/** Reads a provider's error message from the usual shapes, so that it can be shown to the user. */
export function readProviderErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message ??
      (typeof parsed?.detail === "string" ? parsed.detail : undefined) ??
      (Array.isArray(parsed?.detail) ? parsed.detail[0]?.msg : undefined);
    if (typeof message === "string") return message.slice(0, 500);
  } catch {
    // Not JSON; the text itself is the best description.
  }
  return body.trim().slice(0, 500);
}
