/**
 * Grading Evaluators against real providers. They run only where the keys are set, so CI skips
 * them: `OPENAI_API_KEY`, `TYPESAFE_API_KEY` and `ANTHROPIC_API_KEY`, and optionally
 * `OPENAI_TEST_MODEL` and `ANTHROPIC_TEST_MODEL`.
 */
import { assert, assertEquals } from "@std/assert";
import type { GradingEvaluator, LlmProviderKind, PromptVersion } from "@extispex/contracts";
import { type GradingSubject, runGradingEvaluator } from "../src/evaluators/grading-evaluator.ts";
import { createLlmProviderClient } from "../src/llm-providers/llm-provider-client.ts";
import type { PromptClient } from "../src/prompts/prompt-client.ts";
import type {
  LlmProviderConnection,
  LlmProviderRepository,
} from "../src/storage/llm-provider-repository.ts";
import { parseDestinationAllowlist } from "../src/targets/destination-allowlist.ts";

const llmProviderClient = createLlmProviderClient({
  allowlist: parseDestinationAllowlist(
    "api.openai.com:443,api.anthropic.com:443,api.typesafe.ai:443",
  ),
  timeoutMilliseconds: 60_000,
});

const GRADER_PROMPT: PromptVersion = {
  type: "chat",
  messages: [
    {
      role: "system",
      content: "Pass the conversation only if the support bot tells the customer how many days " +
        "they have to ask for a refund.",
    },
    { role: "user", content: "{{transcript}}" },
  ],
  promptName: "refund-grader",
  versionNumber: 1,
  modelParameters: {
    model: null,
    temperature: null,
    maxOutputTokens: null,
    topP: null,
    providerOptions: {},
  },
  variables: ["transcript"],
  commitMessage: null,
  labels: [],
  createdAt: "2026-11-11T10:00:00.000Z",
};

const promptClient: PromptClient = {
  readPromptVersion: () => Promise.resolve({ status: "found", promptVersion: GRADER_PROMPT }),
};

function repositoryWith(connection: LlmProviderConnection): LlmProviderRepository {
  return {
    findProviderForCalling: () => Promise.resolve(connection),
  } as unknown as LlmProviderRepository;
}

function subjectSaying(finalAnswer: string): GradingSubject {
  return {
    projectId: "project-one",
    testCaseName: "cancel-order",
    expectedOutput: null,
    transcript: [
      { stepNumber: 1, input: { message: "Where is my order?" }, output: "It ships today." },
      {
        stepNumber: 2,
        input: { message: "Can I return it if I don't like it?" },
        output: finalAnswer,
      },
    ],
    spans: [],
  };
}

const GOOD_ANSWER = "Yes, you can return it for a full refund within 30 days of delivery.";
const BAD_ANSWER = "Please contact our team, they will help you.";

function defineRealProviderTest(
  kind: LlmProviderKind,
  keyVariable: string,
  defaultModel: string,
  evaluator: GradingEvaluator,
) {
  const apiKey = Deno.env.get(keyVariable);
  Deno.test({
    name: `a real ${kind} provider judges a Transcript`,
    ignore: !apiKey,
    fn: async () => {
      const dependencies = {
        llmProviderRepository: repositoryWith({
          id: "provider-1",
          name: evaluator.providerName,
          kind,
          baseUrl: {
            openai_compatible: "https://api.openai.com/v1",
            anthropic: "https://api.anthropic.com",
            typesafe: "https://api.typesafe.ai",
          }[kind],
          defaultModel,
          apiKey: apiKey ?? null,
        }),
        llmProviderClient,
        promptClient,
      };
      const passed = await runGradingEvaluator(evaluator, subjectSaying(GOOD_ANSWER), dependencies);
      assertEquals(passed.outcome, "passed", passed.reason);
      assert(passed.model, "The provider names the model that judged.");
      const failed = await runGradingEvaluator(evaluator, subjectSaying(BAD_ANSWER), dependencies);
      assertEquals(failed.outcome, "failed", failed.reason);
      console.log(`${kind}: ${passed.model}; passed: ${passed.reason}; failed: ${failed.reason}`);
    },
  });
}

defineRealProviderTest(
  "openai_compatible",
  "OPENAI_API_KEY",
  Deno.env.get("OPENAI_TEST_MODEL") ?? "gpt-4.1-mini",
  {
    type: "grading",
    name: "states-refund-period",
    providerName: "openai",
    prompt: { name: "refund-grader", version: 1 },
    includeSpans: false,
  },
);

defineRealProviderTest(
  "anthropic",
  "ANTHROPIC_API_KEY",
  Deno.env.get("ANTHROPIC_TEST_MODEL") ?? "claude-opus-5-5",
  {
    type: "grading",
    name: "states-refund-period",
    providerName: "anthropic",
    prompt: { name: "refund-grader", version: 1 },
    includeSpans: false,
  },
);

defineRealProviderTest("typesafe", "TYPESAFE_API_KEY", "jev-latest", {
  type: "grading",
  name: "states-refund-period",
  providerName: "jev",
  question: {
    type: "noul",
    instructions: "Does the application tell the customer how many days they have for a refund?",
    criteria: {
      true: "The last answer names a number of days for returns or refunds",
      false: "No refund period is named",
    },
    passProbability: 0.5,
  },
  includeSpans: false,
});

Deno.test({
  name: "a real OpenAI provider writes text",
  ignore: !Deno.env.get("OPENAI_API_KEY"),
  fn: async () => {
    const answer = await llmProviderClient.generateText({
      kind: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: Deno.env.get("OPENAI_API_KEY")!,
    }, {
      messages: [{ role: "user", content: "Say the word ready and nothing else." }],
      settings: {
        model: Deno.env.get("OPENAI_TEST_MODEL") ?? "gpt-4.1-mini",
        temperature: null,
        maxOutputTokens: 20,
        topP: null,
        providerOptions: {},
      },
    });
    assertEquals(answer.status, "answered", answer.status === "error" ? answer.reason : "");
  },
});
