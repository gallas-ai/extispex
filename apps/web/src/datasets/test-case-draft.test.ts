import { assertEquals } from "@std/assert";
import type { TestCase } from "@extispex/contracts";
import {
  checkDraft,
  createDraftFromTestCase,
  NEW_TELEMETRY_EVALUATOR_DRAFT,
  NEW_TEST_CASE_DRAFT,
  type TestCaseDraft,
} from "./test-case-draft.ts";

const VALID_DRAFT = {
  ...NEW_TEST_CASE_DRAFT,
  input: '{"message": "Hello"}',
  evaluators: [{
    type: "regex" as const,
    name: "greets",
    pattern: "Hi",
    flags: "i",
    expectMatch: true,
    step: "",
  }],
};

const TELEMETRY_DRAFT = {
  ...NEW_TELEMETRY_EVALUATOR_DRAFT,
  name: "called-lookup",
  spanName: "execute_tool",
};

function readDefinition(draft: TestCaseDraft) {
  const draftCheck = checkDraft(draft);
  if (!draftCheck.isValid) throw new Error(draftCheck.problem);
  return draftCheck.definition;
}

Deno.test("reads the input as JSON, and as a string otherwise", () => {
  assertEquals(readDefinition(VALID_DRAFT).input, { message: "Hello" });
  assertEquals(readDefinition({ ...VALID_DRAFT, input: "Hello there" }).input, "Hello there");
});

Deno.test("turns the percentage into a share", () => {
  assertEquals(readDefinition({ ...VALID_DRAFT, passThresholdPercent: "66" }).passThreshold, 0.66);
});

Deno.test("explains an incomplete draft", () => {
  for (
    const invalidDraft of [
      { ...VALID_DRAFT, input: " " },
      { ...VALID_DRAFT, iterations: "0" },
      { ...VALID_DRAFT, passThresholdPercent: "0" },
      { ...VALID_DRAFT, passThresholdPercent: "" },
      { ...VALID_DRAFT, evaluators: [{ ...VALID_DRAFT.evaluators[0], pattern: "" }] },
    ]
  ) {
    assertEquals(checkDraft(invalidDraft).isValid, false);
  }
});

Deno.test("keeps a string that looks like JSON a string when edited again", () => {
  const draft = createDraftFromTestCase(
    {
      name: "number-like",
      datasetName: "dataset",
      scope: "trace",
      input: "123",
      expectedOutput: null,
      evaluators: [{ type: "regex", name: "any", pattern: ".", flags: "", expectMatch: true }],
      iterations: 1,
      passThreshold: 0.66,
      createdAt: "",
      updatedAt: "",
    } satisfies TestCase,
  );
  assertEquals(draft.passThresholdPercent, "66");
  assertEquals(readDefinition(draft).input, "123");
});

Deno.test("reads a Telemetry Evaluator's conditions and count", () => {
  const { evaluators } = readDefinition({
    ...VALID_DRAFT,
    evaluators: [{
      ...TELEMETRY_DRAFT,
      status: "ok",
      attributes: '{"gen_ai.tool.name": "lookup", "retries": 2}',
      minimumCount: "2",
      maximumCount: "3",
    }],
  });
  assertEquals(evaluators[0], {
    type: "telemetry",
    name: "called-lookup",
    match: {
      name: "execute_tool",
      status: "ok",
      attributes: { "gen_ai.tool.name": "lookup", retries: 2 },
    },
    count: { min: 2, max: 3 },
  });
});

Deno.test("explains an incomplete Telemetry Evaluator", () => {
  for (
    const invalidEvaluator of [
      { ...TELEMETRY_DRAFT, spanName: "" },
      { ...TELEMETRY_DRAFT, attributes: "not json" },
      { ...TELEMETRY_DRAFT, attributes: '["a list"]' },
      { ...TELEMETRY_DRAFT, attributes: '{"nested": {"value": 1}}' },
      { ...TELEMETRY_DRAFT, minimumCount: "many" },
      { ...TELEMETRY_DRAFT, minimumCount: "0" },
      { ...TELEMETRY_DRAFT, minimumCount: "3", maximumCount: "2" },
    ]
  ) {
    assertEquals(checkDraft({ ...VALID_DRAFT, evaluators: [invalidEvaluator] }).isValid, false);
  }
  const forbidsSpan = { ...TELEMETRY_DRAFT, minimumCount: "0", maximumCount: "0" };
  assertEquals(checkDraft({ ...VALID_DRAFT, evaluators: [forbidsSpan] }).isValid, true);
});

Deno.test("shows a stored Telemetry Evaluator in the editor", () => {
  const draft = createDraftFromTestCase(
    {
      name: "tool",
      datasetName: "dataset",
      scope: "trace",
      input: "Hi",
      expectedOutput: null,
      evaluators: [{
        type: "telemetry",
        name: "no-delete",
        match: { name: "delete_order", attributes: { retries: 2 } },
        count: { min: 0, max: 0 },
      }],
      iterations: 1,
      passThreshold: 1,
      createdAt: "",
      updatedAt: "",
    } satisfies TestCase,
  );
  assertEquals(readDefinition(draft).evaluators, [{
    type: "telemetry",
    name: "no-delete",
    match: { name: "delete_order", attributes: { retries: 2 } },
    count: { min: 0, max: 0 },
  }]);
});

Deno.test("turns a Session draft into steps, and lets a Regex Evaluator pick one", () => {
  const sessionDraft: TestCaseDraft = {
    ...VALID_DRAFT,
    scope: "session",
    input: "ignored",
    steps: ['{"message": "Where is my order?"}', "Can I cancel it?"],
    evaluators: [{ ...VALID_DRAFT.evaluators[0], step: "1" }],
  };
  const definition = readDefinition(sessionDraft);
  assertEquals(definition.scope, "session");
  assertEquals(definition.input, undefined);
  assertEquals(definition.steps, [
    { input: { message: "Where is my order?" } },
    { input: "Can I cancel it?" },
  ]);
  assertEquals((definition.evaluators[0] as { step?: number }).step, 1);
  assertEquals(checkDraft({ ...sessionDraft, steps: ["Hello", " "] }).isValid, false);
  assertEquals(checkDraft({ ...sessionDraft, steps: [] }).isValid, false);
  // A trace-scoped Test Case ignores a step left over from editing a Session.
  assertEquals(
    (readDefinition({ ...sessionDraft, scope: "trace", input: "Hi" }).evaluators[0] as {
      step?: number;
    }).step,
    undefined,
  );
});
