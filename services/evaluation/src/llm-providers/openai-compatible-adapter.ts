import { z } from "zod";
import { joinUrl, type ProviderAdapter } from "./provider-adapter.ts";

const chatCompletionSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      refusal: z.string().nullable().optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
});

/**
 * OpenAI's Chat Completions API, which Azure OpenAI's v1 API and local servers such as vLLM and
 * Ollama also offer. A structured answer uses `response_format` with a strict JSON Schema.
 */
export const openAiCompatibleAdapter: ProviderAdapter = {
  capabilities: ["text_generation"],

  buildTextRequest(endpoint, { messages, settings, responseFormat }) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (endpoint.apiKey !== null) headers.authorization = `Bearer ${endpoint.apiKey}`;
    return {
      url: joinUrl(endpoint.baseUrl, "chat/completions"),
      headers,
      body: {
        ...settings.providerOptions,
        model: settings.model,
        messages: messages.map(({ role, content }) => ({ role, content })),
        ...(settings.temperature === null ? {} : { temperature: settings.temperature }),
        ...(settings.topP === null ? {} : { top_p: settings.topP }),
        ...(settings.maxOutputTokens === null
          ? {}
          : { max_completion_tokens: settings.maxOutputTokens }),
        ...(responseFormat === undefined ? {} : {
          response_format: {
            type: "json_schema",
            json_schema: { name: responseFormat.name, strict: true, schema: responseFormat.schema },
          },
        }),
      },
    };
  },

  parseTextResponse(body) {
    const completion = chatCompletionSchema.safeParse(body);
    if (!completion.success) {
      return { status: "error", reason: "The LLM provider's answer has no message." };
    }
    const [choice] = completion.data.choices;
    if (choice.message.refusal) {
      return { status: "error", reason: `The model refused: ${choice.message.refusal}` };
    }
    if (choice.message.content == null || choice.message.content === "") {
      return { status: "error", reason: "The LLM provider's answer is empty." };
    }
    if (choice.finish_reason === "length") {
      return { status: "error", reason: "The answer was cut off at the output token limit." };
    }
    return {
      status: "answered",
      value: choice.message.content,
      model: completion.data.model ?? null,
    };
  },
};
