import {
  LLM_PROVIDER_CAPABILITIES,
  type PromptMessage,
  type PromptVersion,
} from "@extispex/contracts";
import type { LlmProviderClient } from "../llm-providers/mod.ts";
import type { PromptClient } from "../prompts/mod.ts";
import { readGenerationSettings, readPromptMessages, renderPrompt } from "../prompts/mod.ts";
import type { RunForSummary, SummaryClaim } from "../storage/mod.ts";
import type { LlmProviderRepository } from "../storage/mod.ts";

/** An LLM Summary is an overview, so a longer answer is cut here rather than stored whole. */
export const MAXIMUM_SUMMARY_LENGTH = 20_000;
const DEFAULT_SUMMARY_OUTPUT_TOKENS = 1_024;

/**
 * The default prompt. `{{results}}` is the run as text; a user's own Prompt Version may also use
 * `{{datasetName}}` and `{{verdict}}`.
 */
export const DEFAULT_SUMMARY_PROMPT: PromptMessage[] = [
  {
    role: "system",
    content: "You write the LLM Summary of an Evaluation Run in Extispex, a platform that tests " +
      "GenAI applications. Readers are the engineers who own the application. In at most 150 " +
      "words of plain text: state the verdict, name the Test Cases that failed or ended as Error " +
      "and what their reasons have in common, and suggest where to look first. An Error means " +
      "the result could not be obtained and says nothing about the application's quality. Do " +
      "not invent details that the results do not contain.",
  },
  { role: "user", content: "{{results}}" },
];

export type SummaryResult =
  | { status: "completed"; text: string; model: string }
  | { status: "failed"; error: string; isRetryable: boolean };

export interface LlmSummaryDependencies {
  llmProviderRepository: LlmProviderRepository;
  llmProviderClient: LlmProviderClient;
  promptClient: PromptClient;
}

/** The run's results as text: the verdict, then each Test Case with its reasons. */
export function formatRunResults(run: RunForSummary): string {
  const lines = [
    `Dataset: ${run.datasetName}`,
    `Verdict: ${run.verdict}`,
    run.targetName === null
      ? "Execution: Client-Driven, by the user's script"
      : `Execution: Server-Driven, against the Target ${run.targetName}`,
    `Duration: ${Math.round((run.finishedAt.getTime() - run.createdAt.getTime()) / 1_000)} seconds`,
    `Test Cases: ${run.totalTestCases}, of which ${
      run.testCases.filter((testCase) => testCase.outcome === "passed").length
    } of the first ${run.testCases.length} passed`,
    "",
  ];
  for (const testCase of run.testCases) {
    lines.push(
      `- ${testCase.name} (${testCase.scope === "session" ? "Session" : "trace"}): ` +
        `${testCase.outcome}, ${testCase.passedIterations} of ${testCase.totalIterations} ` +
        "Iterations passed",
    );
    for (const reason of testCase.reasons) lines.push(`  - ${reason}`);
  }
  if (run.totalTestCases > run.testCases.length) {
    lines.push(`- … and ${run.totalTestCases - run.testCases.length} more Test Cases`);
  }
  return lines.join("\n");
}

/** Writes a finished run's LLM Summary with the provider and prompt the run took at its end. */
export async function writeLlmSummary(
  claim: SummaryClaim,
  run: RunForSummary,
  dependencies: LlmSummaryDependencies,
): Promise<SummaryResult> {
  const failPermanently = (error: string): SummaryResult => ({
    status: "failed",
    error,
    isRetryable: false,
  });
  const provider = claim.providerId === null
    ? null
    : await dependencies.llmProviderRepository.readProviderForCalling(claim.providerId);
  if (provider === null) {
    return failPermanently(`The LLM provider ${claim.providerName} no longer exists.`);
  }
  if (!LLM_PROVIDER_CAPABILITIES[provider.kind].includes("text_generation")) {
    return failPermanently(`The LLM provider ${provider.name} cannot write text.`);
  }
  let promptVersion: PromptVersion | null = null;
  if (claim.prompt !== null) {
    const lookup = await dependencies.promptClient.readPromptVersion(
      claim.projectId,
      claim.prompt.name,
      claim.prompt.version,
    );
    if (lookup.status === "not_found") {
      return failPermanently(`Prompt ${claim.prompt.name} has no version ${claim.prompt.version}.`);
    }
    if (lookup.status === "unavailable") {
      return { status: "failed", error: lookup.reason, isRetryable: true };
    }
    promptVersion = lookup.promptVersion;
  }
  const rendered = renderPrompt(
    promptVersion === null ? DEFAULT_SUMMARY_PROMPT : readPromptMessages(promptVersion),
    { results: formatRunResults(run), datasetName: run.datasetName, verdict: run.verdict },
  );
  if (rendered.status === "unknown_variables") {
    return failPermanently(
      `The prompt uses ${
        rendered.variableNames.map((name) => `{{${name}}}`).join(", ")
      }, which an LLM Summary does not fill.`,
    );
  }
  const answer = await dependencies.llmProviderClient.generateText(provider, {
    messages: rendered.messages,
    settings: readGenerationSettings(
      promptVersion,
      provider.defaultModel,
      DEFAULT_SUMMARY_OUTPUT_TOKENS,
    ),
  });
  if (answer.status === "error") {
    return { status: "failed", error: answer.reason, isRetryable: true };
  }
  return {
    status: "completed",
    text: answer.value.trim().slice(0, MAXIMUM_SUMMARY_LENGTH),
    model: answer.model,
  };
}
