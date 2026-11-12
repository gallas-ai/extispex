import type { JudgmentQuestion } from "@extispex/contracts";
import { z } from "zod";
import { joinUrl, type JudgmentAnswer, type ProviderAdapter } from "./provider-adapter.ts";

/** The name of the one question each request asks; Jev answers under the same name. */
const QUESTION_NAME = "verdict";

const probabilitiesSchema = z.record(z.string(), z.number());

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    confidence: z.number(),
    probabilities: probabilitiesSchema,
  }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number(),
    probabilities: probabilitiesSchema,
  }),
]);

const systemOneResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
});

/** A question as the System One API takes it: Extispex's pass rules stay on this side. */
function toSystemOneQuestion(question: JudgmentQuestion): Record<string, unknown> {
  if (question.type === "noul") {
    return {
      type: "noul",
      instructions: question.instructions,
      ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
    };
  }
  return { type: question.type, instructions: question.instructions, criteria: question.criteria };
}

/**
 * TypeSafe's System One API, which Jev answers. It takes a state and typed questions instead of a
 * prompt, and answers with probabilities rather than text. See ADR 0016.
 */
export const typeSafeAdapter: ProviderAdapter = {
  capabilities: ["judgment"],

  buildJudgmentRequest(endpoint, { state, question, model }) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (endpoint.apiKey !== null) headers.authorization = `Bearer ${endpoint.apiKey}`;
    return {
      url: joinUrl(endpoint.baseUrl, "v1/systemone"),
      headers,
      body: { model, state, questions: { [QUESTION_NAME]: toSystemOneQuestion(question) } },
    };
  },

  parseJudgmentResponse(body, { question }) {
    const response = systemOneResponseSchema.safeParse(body);
    const answer = answerSchema.safeParse(response.data?.answers[QUESTION_NAME]);
    if (!response.success || !answer.success || answer.data.type !== question.type) {
      return { status: "error", reason: "The LLM provider's answer does not fit the question." };
    }
    const typedAnswer: JudgmentAnswer = answer.data;
    if (
      typedAnswer.type === "choice" && question.type === "choice" &&
      !(typedAnswer.choice in question.criteria)
    ) {
      return {
        status: "error",
        reason: `Jev chose "${typedAnswer.choice}", which was not offered.`,
      };
    }
    return { status: "answered", value: typedAnswer, model: response.data.model ?? null };
  },
};
