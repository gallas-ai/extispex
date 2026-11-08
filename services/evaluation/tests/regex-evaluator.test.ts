import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runRegexEvaluator } from "../src/evaluators/regex-evaluator.ts";

const MENTIONS_DAYS = { name: "days", pattern: "30\\s*days", flags: "i", expectMatch: true };

Deno.test("passes when the Output matches", async () => {
  const result = await runRegexEvaluator(MENTIONS_DAYS, "Within 30 DAYS.", 1_000);
  assertEquals(result.outcome, "passed");
});

Deno.test("fails when the Output does not match", async () => {
  const result = await runRegexEvaluator(MENTIONS_DAYS, "Within a month.", 1_000);
  assertEquals(result.outcome, "failed");
});

Deno.test("expectMatch false fails on a match", async () => {
  const result = await runRegexEvaluator(
    { ...MENTIONS_DAYS, expectMatch: false },
    "Within 30 days.",
    1_000,
  );
  assertEquals(result.outcome, "failed");
});

Deno.test("terminates a catastrophic pattern and reports an Error", async () => {
  const startedAt = performance.now();
  const result = await runRegexEvaluator(
    { name: "slow", pattern: "^(a+)+$", flags: "", expectMatch: true },
    `${"a".repeat(40)}!`,
    200,
  );
  assertEquals(result.outcome, "error");
  assertStringIncludes(result.reason, "200 ms");
  assert(performance.now() - startedAt < 10_000, "The thread should be terminated promptly.");
});
