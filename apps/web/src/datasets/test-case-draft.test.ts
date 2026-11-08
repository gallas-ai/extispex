import { assertEquals } from "@std/assert";
import type { TestCase } from "@extispex/contracts";
import { checkDraft, createDraftFromTestCase, NEW_TEST_CASE_DRAFT } from "./test-case-draft.ts";

const VALID_DRAFT = {
  ...NEW_TEST_CASE_DRAFT,
  input: '{"message": "Hello"}',
  evaluators: [{ name: "greets", pattern: "Hi", flags: "i", expectMatch: true }],
};

function readDefinition(draft: typeof VALID_DRAFT) {
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
