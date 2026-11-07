/**
 * The OpenTelemetry GenAI semantic convention attributes that the UI highlights. Spans without
 * them are shown as plain spans.
 */
export interface GenAiSpanSummary {
  model: string | null;
  toolName: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function summarizeGenAiSpan(attributes: Record<string, unknown>): GenAiSpanSummary {
  return {
    model: readString(attributes["gen_ai.response.model"]) ??
      readString(attributes["gen_ai.request.model"]),
    toolName: readString(attributes["gen_ai.tool.name"]),
    inputTokens: readNumber(attributes["gen_ai.usage.input_tokens"]),
    outputTokens: readNumber(attributes["gen_ai.usage.output_tokens"]),
  };
}

function readString(attributeValue: unknown): string | null {
  return typeof attributeValue === "string" && attributeValue !== "" ? attributeValue : null;
}

function readNumber(attributeValue: unknown): number | null {
  if (typeof attributeValue === "number" && Number.isFinite(attributeValue)) {
    return attributeValue;
  }
  if (typeof attributeValue === "string" && /^\d+$/.test(attributeValue)) {
    return Number(attributeValue);
  }
  return null;
}
