import {
  type EvaluatorResult,
  type GradingEvaluator,
  type JudgmentQuestion,
  LLM_PROVIDER_CAPABILITIES,
  type Span,
} from "@extispex/contracts";
import { z } from "zod";
import type { LlmProviderClient } from "../llm-providers/mod.ts";
import type { JudgmentAnswer } from "../llm-providers/mod.ts";
import type { PromptClient } from "../prompts/mod.ts";
import {
  addSystemInstruction,
  copyPromptVersion,
  readGenerationSettings,
  readPromptMessages,
  renderPrompt,
} from "../prompts/mod.ts";
import type { LlmProviderRepository } from "../storage/mod.ts";

/** At most this many spans are shown to the LLM, so that one busy Session cannot fill a prompt. */
export const MAXIMUM_GRADED_SPANS = 200;

/** One step of the Transcript a Grading Evaluator judges. A trace-scoped Test Case has one. */
export interface GradedStep {
  stepNumber: number;
  input: unknown;
  output: string;
}

/** What a Grading Evaluator sees of an attempt. */
export interface GradingSubject {
  projectId: string;
  testCaseName: string;
  expectedOutput: string | null;
  transcript: GradedStep[];
  spans: Span[];
}

export interface GradingDependencies {
  llmProviderRepository: LlmProviderRepository;
  llmProviderClient: LlmProviderClient;
  promptClient: PromptClient;
}

/**
 * The structured verdict a Text Generation provider is asked for. A verdict that does not follow it
 * is an Error, never a failure: it says nothing about the application.
 */
export const gradingVerdictSchema = z.strictObject({
  passed: z.boolean(),
  score: z.number().min(0).max(1).nullable(),
  explanation: z.string().min(1).max(10_000),
});

/** The same verdict as a JSON Schema in the subset that OpenAI's strict mode accepts. */
export const GRADING_VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean", description: "Whether the application's behaviour passes." },
    score: {
      type: ["number", "null"],
      description: "How well it did, from 0 to 1, or null if the criteria give no scale.",
    },
    explanation: { type: "string", description: "Why, in one to three sentences." },
  },
  required: ["passed", "score", "explanation"],
  additionalProperties: false,
};

export const GRADING_VERDICT_INSTRUCTION =
  "You judge a GenAI application's behaviour for an automated evaluation. Answer only with a JSON " +
  'object {"passed": boolean, "score": number from 0 to 1 or null, "explanation": string}: ' +
  "`passed` says whether the behaviour meets the criteria in this prompt, `score` how well, and " +
  "`explanation` why, in one to three sentences.";

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The Transcript as plain text, one user message and Output after another. */
export function formatTranscript(transcript: GradedStep[]): string {
  return transcript.map((step) =>
    `User (step ${step.stepNumber}): ${formatValue(step.input)}\nApplication: ${step.output}`
  ).join("\n\n");
}

/** The fields of a span that say what happened, without its bookkeeping. */
function describeSpans(spans: Span[]) {
  return spans.slice(0, MAXIMUM_GRADED_SPANS).map((span) => ({
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    status: span.statusCode,
    durationMilliseconds: span.durationMilliseconds,
    serviceName: span.serviceName,
    attributes: span.attributes,
  }));
}

/** The Prompt Variables a Grading Evaluator's prompt may use. */
export function createGradingVariables(
  evaluator: GradingEvaluator,
  subject: GradingSubject,
): Record<string, string> {
  const lastStep = subject.transcript.at(-1);
  return {
    transcript: formatTranscript(subject.transcript),
    input: lastStep === undefined ? "" : formatValue(lastStep.input),
    output: lastStep?.output ?? "",
    expectedOutput: subject.expectedOutput ?? "",
    testCaseName: subject.testCaseName,
    ...(evaluator.includeSpans ? { spans: JSON.stringify(describeSpans(subject.spans)) } : {}),
  };
}

/** What Jev reads: the Transcript and what the Test Case expects, as one JSON state. */
export function createJudgmentState(evaluator: GradingEvaluator, subject: GradingSubject) {
  return {
    testCase: subject.testCaseName,
    ...(subject.expectedOutput === null ? {} : { expectedOutput: subject.expectedOutput }),
    transcript: subject.transcript.map((step) => ({
      step: step.stepNumber,
      input: step.input,
      output: step.output,
    })),
    ...(evaluator.includeSpans ? { spans: describeSpans(subject.spans) } : {}),
  };
}

function formatProbability(probability: number): string {
  return probability.toFixed(2);
}

/** Turns Jev's probabilities into pass or fail by the Evaluator's own rule. See ADR 0016. */
export function judgeAnswer(
  question: JudgmentQuestion,
  answer: JudgmentAnswer,
): { passed: boolean; score: number; reason: string } {
  if (question.type === "noul" && answer.type === "noul") {
    return {
      passed: answer.noul >= question.passProbability,
      score: answer.noul,
      reason: `The probability of yes is ${formatProbability(answer.noul)}; ${
        formatProbability(question.passProbability)
      } or more passes.`,
    };
  }
  if (question.type === "score" && answer.type === "score") {
    const highestLevel = question.criteria.length - 1;
    const nearestLevel = Math.min(Math.max(Math.round(answer.score), 0), highestLevel);
    return {
      passed: answer.score >= question.passScore,
      score: Math.min(Math.max(answer.score / highestLevel, 0), 1),
      reason: `The expected level is ${formatProbability(answer.score)} of ${highestLevel}, ` +
        `nearest to "${question.criteria[nearestLevel]}"; ${question.passScore} or more passes.`,
    };
  }
  if (question.type === "choice" && answer.type === "choice") {
    const passingProbability = question.passingChoices.reduce(
      (total, choice) => total + (answer.probabilities[choice] ?? 0),
      0,
    );
    return {
      passed: question.passingChoices.includes(answer.choice),
      score: Math.min(passingProbability, 1),
      reason: `The choice is "${answer.choice}" with confidence ${
        formatProbability(answer.confidence)
      }; passing choices are ${question.passingChoices.map((choice) => `"${choice}"`).join(", ")}.`,
    };
  }
  throw new Error("The answer does not fit the question.");
}

/** Asks the provider for a verdict on the Transcript. Every problem is the Evaluator's Error. */
export async function runGradingEvaluator(
  evaluator: GradingEvaluator,
  subject: GradingSubject,
  dependencies: GradingDependencies,
): Promise<EvaluatorResult> {
  const baseResult = { name: evaluator.name, type: "grading" as const };
  const error = (reason: string): EvaluatorResult => ({ ...baseResult, outcome: "error", reason });
  const provider = await dependencies.llmProviderRepository.findProviderForCalling(
    subject.projectId,
    evaluator.providerName,
  );
  if (provider === null) return error(`The LLM provider ${evaluator.providerName} does not exist.`);
  const capabilities = LLM_PROVIDER_CAPABILITIES[provider.kind];

  if (evaluator.question !== undefined) {
    if (!capabilities.includes("judgment")) {
      return error(`The LLM provider ${provider.name} cannot answer typed questions.`);
    }
    const answer = await dependencies.llmProviderClient.answerQuestion(provider, {
      state: createJudgmentState(evaluator, subject),
      question: evaluator.question,
      model: provider.defaultModel,
    });
    if (answer.status === "error") return error(answer.reason);
    const judgment = judgeAnswer(evaluator.question, answer.value);
    return {
      ...baseResult,
      outcome: judgment.passed ? "passed" : "failed",
      reason: judgment.reason,
      score: judgment.score,
      model: answer.model,
    };
  }

  const promptReference = evaluator.prompt!;
  if (!capabilities.includes("text_generation")) {
    return error(`The LLM provider ${provider.name} cannot follow a prompt.`);
  }
  const lookup = await dependencies.promptClient.readPromptVersion(
    subject.projectId,
    promptReference.name,
    promptReference.version,
  );
  if (lookup.status === "not_found") {
    return error(`Prompt ${promptReference.name} has no version ${promptReference.version}.`);
  }
  if (lookup.status === "unavailable") return error(lookup.reason);
  const { promptVersion } = lookup;
  const usedPrompt = copyPromptVersion(promptVersion);
  const rendered = renderPrompt(
    readPromptMessages(promptVersion),
    createGradingVariables(evaluator, subject),
  );
  if (rendered.status === "unknown_variables") {
    return {
      ...error(
        `The prompt uses ${
          rendered.variableNames.map((name) => `{{${name}}}`).join(", ")
        }, which a Grading Evaluator does not fill.` +
          (rendered.variableNames.includes("spans") ? " Turn on includeSpans for {{spans}}." : ""),
      ),
      prompt: usedPrompt,
    };
  }
  const answer = await dependencies.llmProviderClient.generateText(provider, {
    messages: addSystemInstruction(rendered.messages, GRADING_VERDICT_INSTRUCTION),
    settings: readGenerationSettings(promptVersion, provider.defaultModel),
    responseFormat: { name: "verdict", schema: GRADING_VERDICT_JSON_SCHEMA },
  });
  if (answer.status === "error") return { ...error(answer.reason), prompt: usedPrompt };
  const verdict = parseVerdict(answer.value);
  if (verdict === null) {
    return {
      ...error("The LLM's verdict is not the JSON object it was asked for."),
      model: answer.model,
      prompt: usedPrompt,
    };
  }
  return {
    ...baseResult,
    outcome: verdict.passed ? "passed" : "failed",
    reason: verdict.explanation,
    score: verdict.score,
    model: answer.model,
    prompt: usedPrompt,
  };
}

/** Accepts the JSON object alone, or inside a Markdown code block as some local models write it. */
export function parseVerdict(text: string): z.infer<typeof gradingVerdictSchema> | null {
  const unfenced = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    const verdict = gradingVerdictSchema.safeParse(JSON.parse(unfenced));
    return verdict.success ? verdict.data : null;
  } catch {
    return null;
  }
}
