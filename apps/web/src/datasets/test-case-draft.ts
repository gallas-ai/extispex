import type { TestCase, TestCaseDefinitionInput } from "@extispex/contracts";

export interface RegexEvaluatorDraft {
  name: string;
  pattern: string;
  flags: string;
  expectMatch: boolean;
}

/** A Test Case as the editor holds it: every field as the text in its input. */
export interface TestCaseDraft {
  name: string;
  input: string;
  expectedOutput: string;
  iterations: string;
  passThresholdPercent: string;
  evaluators: RegexEvaluatorDraft[];
}

export const NEW_TEST_CASE_DRAFT: TestCaseDraft = {
  name: "",
  input: "",
  expectedOutput: "",
  iterations: "1",
  passThresholdPercent: "100",
  evaluators: [{ name: "", pattern: "", flags: "", expectMatch: true }],
};

export type DraftCheck = { isValid: true; definition: TestCaseDefinitionInput } | {
  isValid: false;
  problem: string;
};

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Plain text stays a string; text that would read as JSON is shown with its quotes. */
function formatInput(input: unknown): string {
  if (typeof input === "string" && !isJsonText(input)) return input;
  return JSON.stringify(input, null, 2);
}

export function createDraftFromTestCase(testCase: TestCase): TestCaseDraft {
  return {
    name: testCase.name,
    input: formatInput(testCase.input),
    expectedOutput: testCase.expectedOutput ?? "",
    iterations: String(testCase.iterations),
    passThresholdPercent: String(Math.round(testCase.passThreshold * 10_000) / 100),
    evaluators: testCase.evaluators.map(({ name, pattern, flags, expectMatch }) => ({
      name,
      pattern,
      flags,
      expectMatch,
    })),
  };
}

export function checkDraft(draft: TestCaseDraft): DraftCheck {
  if (draft.input.trim() === "") return { isValid: false, problem: "Give the Test Case an input." };
  const iterations = Number(draft.iterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
    return { isValid: false, problem: "Iterations must be a whole number from 1 to 100." };
  }
  const passThresholdPercent = Number(draft.passThresholdPercent);
  if (
    draft.passThresholdPercent.trim() === "" || Number.isNaN(passThresholdPercent) ||
    passThresholdPercent <= 0 || passThresholdPercent > 100
  ) {
    return { isValid: false, problem: "The Pass Threshold must be above 0% and at most 100%." };
  }
  if (draft.evaluators.some((evaluator) => evaluator.name.trim() === "")) {
    return { isValid: false, problem: "Give every Evaluator a name." };
  }
  if (draft.evaluators.some((evaluator) => evaluator.pattern === "")) {
    return { isValid: false, problem: "Give every Evaluator a regular expression." };
  }
  return {
    isValid: true,
    definition: {
      input: isJsonText(draft.input) ? JSON.parse(draft.input) : draft.input,
      expectedOutput: draft.expectedOutput === "" ? null : draft.expectedOutput,
      iterations,
      passThreshold: passThresholdPercent / 100,
      evaluators: draft.evaluators.map((evaluator) => ({
        type: "regex" as const,
        name: evaluator.name.trim(),
        pattern: evaluator.pattern,
        flags: evaluator.flags,
        expectMatch: evaluator.expectMatch,
      })),
    },
  };
}
