import type {
  Evaluator,
  SpanStatusCode,
  TestCase,
  TestCaseDefinitionInput,
} from "@extispex/contracts";

export interface RegexEvaluatorDraft {
  type: "regex";
  name: string;
  pattern: string;
  flags: string;
  expectMatch: boolean;
}

export interface TelemetryEvaluatorDraft {
  type: "telemetry";
  name: string;
  spanName: string;
  /** Empty for any status. */
  status: SpanStatusCode | "";
  /** The attributes as JSON text, or empty for none. */
  attributes: string;
  minimumCount: string;
  /** Empty for no upper limit. */
  maximumCount: string;
}

export type EvaluatorDraft = RegexEvaluatorDraft | TelemetryEvaluatorDraft;

/** A Test Case as the editor holds it: every field as the text in its input. */
export interface TestCaseDraft {
  name: string;
  input: string;
  expectedOutput: string;
  iterations: string;
  passThresholdPercent: string;
  evaluators: EvaluatorDraft[];
}

export const NEW_REGEX_EVALUATOR_DRAFT: RegexEvaluatorDraft = {
  type: "regex",
  name: "",
  pattern: "",
  flags: "",
  expectMatch: true,
};

export const NEW_TELEMETRY_EVALUATOR_DRAFT: TelemetryEvaluatorDraft = {
  type: "telemetry",
  name: "",
  spanName: "",
  status: "",
  attributes: "",
  minimumCount: "1",
  maximumCount: "",
};

export const NEW_TEST_CASE_DRAFT: TestCaseDraft = {
  name: "",
  input: "",
  expectedOutput: "",
  iterations: "1",
  passThresholdPercent: "100",
  evaluators: [NEW_REGEX_EVALUATOR_DRAFT],
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

function createEvaluatorDraft(evaluator: Evaluator): EvaluatorDraft {
  if (evaluator.type === "regex") {
    const { name, pattern, flags, expectMatch } = evaluator;
    return { type: "regex", name, pattern, flags, expectMatch };
  }
  return {
    type: "telemetry",
    name: evaluator.name,
    spanName: evaluator.match.name ?? "",
    status: evaluator.match.status ?? "",
    attributes: Object.keys(evaluator.match.attributes).length === 0
      ? ""
      : JSON.stringify(evaluator.match.attributes, null, 2),
    minimumCount: String(evaluator.count.min),
    maximumCount: evaluator.count.max === undefined ? "" : String(evaluator.count.max),
  };
}

export function createDraftFromTestCase(testCase: TestCase): TestCaseDraft {
  return {
    name: testCase.name,
    input: formatInput(testCase.input),
    expectedOutput: testCase.expectedOutput ?? "",
    iterations: String(testCase.iterations),
    passThresholdPercent: String(Math.round(testCase.passThreshold * 10_000) / 100),
    evaluators: testCase.evaluators.map(createEvaluatorDraft),
  };
}

type AttributeValues = Record<string, string | number | boolean>;

function parseAttributes(attributesText: string): AttributeValues | null {
  if (attributesText.trim() === "") return {};
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(attributesText);
  } catch {
    return null;
  }
  if (typeof parsedValue !== "object" || parsedValue === null || Array.isArray(parsedValue)) {
    return null;
  }
  const hasOnlyScalars = Object.values(parsedValue).every((attributeValue) =>
    ["string", "number", "boolean"].includes(typeof attributeValue)
  );
  return hasOnlyScalars ? parsedValue as AttributeValues : null;
}

function isCount(countText: string): boolean {
  return /^\d+$/.test(countText.trim());
}

function findTelemetryEvaluatorProblem(draft: TelemetryEvaluatorDraft): string | null {
  const attributes = parseAttributes(draft.attributes);
  if (attributes === null) {
    return "Write a Telemetry Evaluator's attributes as a JSON object of strings, numbers and booleans.";
  }
  if (draft.spanName.trim() === "" && draft.status === "" && Object.keys(attributes).length === 0) {
    return "Give every Telemetry Evaluator a span name, a status or an attribute.";
  }
  if (!isCount(draft.minimumCount)) {
    return "A Telemetry Evaluator's minimum count must be a whole number.";
  }
  if (draft.maximumCount.trim() === "") {
    return Number(draft.minimumCount) === 0
      ? "With a minimum count of 0, give a maximum count."
      : null;
  }
  if (!isCount(draft.maximumCount)) {
    return "A Telemetry Evaluator's maximum count must be a whole number.";
  }
  return Number(draft.maximumCount) < Number(draft.minimumCount)
    ? "A Telemetry Evaluator's maximum count must not be below its minimum."
    : null;
}

function findEvaluatorProblem(draft: EvaluatorDraft): string | null {
  if (draft.name.trim() === "") return "Give every Evaluator a name.";
  if (draft.type === "telemetry") return findTelemetryEvaluatorProblem(draft);
  return draft.pattern === "" ? "Give every Evaluator a regular expression." : null;
}

function toEvaluatorDefinition(draft: EvaluatorDraft) {
  if (draft.type === "regex") {
    return {
      type: "regex" as const,
      name: draft.name.trim(),
      pattern: draft.pattern,
      flags: draft.flags,
      expectMatch: draft.expectMatch,
    };
  }
  return {
    type: "telemetry" as const,
    name: draft.name.trim(),
    match: {
      ...(draft.spanName.trim() === "" ? {} : { name: draft.spanName.trim() }),
      ...(draft.status === "" ? {} : { status: draft.status }),
      attributes: parseAttributes(draft.attributes) ?? {},
    },
    count: {
      min: Number(draft.minimumCount),
      ...(draft.maximumCount.trim() === "" ? {} : { max: Number(draft.maximumCount) }),
    },
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
  for (const evaluator of draft.evaluators) {
    const problem = findEvaluatorProblem(evaluator);
    if (problem !== null) return { isValid: false, problem };
  }
  return {
    isValid: true,
    definition: {
      input: isJsonText(draft.input) ? JSON.parse(draft.input) : draft.input,
      expectedOutput: draft.expectedOutput === "" ? null : draft.expectedOutput,
      iterations,
      passThreshold: passThresholdPercent / 100,
      evaluators: draft.evaluators.map(toEvaluatorDefinition),
    },
  };
}
