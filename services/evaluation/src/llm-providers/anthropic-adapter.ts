import { z } from "zod";
import { joinUrl, type ProviderAdapter } from "./provider-adapter.ts";

/** Anthropic's Messages API version that the requests are written for. */
export const ANTHROPIC_API_VERSION = "2023-06-01";
/** The Messages API needs a limit; this one leaves room for a long LLM Summary. */
const DEFAULT_MAXIMUM_OUTPUT_TOKENS = 4_096;

const messageResponseSchema = z.object({
  model: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/**
 * Anthropic's Messages API. System messages go into `system`, and a structured answer uses
 * `output_config.format` with a JSON Schema. Current Claude models refuse `temperature` and `top_p`,
 * so those are sent only when the Prompt Version sets them.
 */
export const anthropicAdapter: ProviderAdapter = {
  capabilities: ["text_generation"],

  buildTextRequest(endpoint, { messages, settings, responseFormat }) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
    };
    if (endpoint.apiKey !== null) headers["x-api-key"] = endpoint.apiKey;
    const systemText = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    return {
      url: joinUrl(endpoint.baseUrl, "v1/messages"),
      headers,
      body: {
        ...settings.providerOptions,
        model: settings.model,
        max_tokens: settings.maxOutputTokens ?? DEFAULT_MAXIMUM_OUTPUT_TOKENS,
        ...(systemText === "" ? {} : { system: systemText }),
        messages: messages
          .filter((message) => message.role !== "system")
          .map(({ role, content }) => ({ role, content })),
        ...(settings.temperature === null ? {} : { temperature: settings.temperature }),
        ...(settings.topP === null ? {} : { top_p: settings.topP }),
        ...(responseFormat === undefined
          ? {}
          : { output_config: { format: { type: "json_schema", schema: responseFormat.schema } } }),
      },
    };
  },

  parseTextResponse(body) {
    const message = messageResponseSchema.safeParse(body);
    if (!message.success) {
      return { status: "error", reason: "The LLM provider's answer has no content." };
    }
    if (message.data.stop_reason === "refusal") {
      return { status: "error", reason: "The model declined to answer." };
    }
    if (message.data.stop_reason === "max_tokens") {
      return { status: "error", reason: "The answer was cut off at the output token limit." };
    }
    const text = message.data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    if (text === "") return { status: "error", reason: "The LLM provider's answer is empty." };
    return { status: "answered", value: text, model: message.data.model ?? null };
  },
};
