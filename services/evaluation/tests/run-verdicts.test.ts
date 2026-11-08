import { assertEquals } from "@std/assert";
import type { EvaluatorResult, Verdict } from "@extispex/contracts";
import {
  decideIterationOutcome,
  decideRunVerdict,
  decideTestCaseOutcome,
} from "../src/evaluation-runs/run-verdicts.ts";

function resultWith(outcome: Verdict): EvaluatorResult {
  return { name: outcome, type: "regex", outcome, reason: "" };
}

Deno.test("an Iteration passes only if all of its Evaluators pass", () => {
  assertEquals(decideIterationOutcome([resultWith("passed"), resultWith("passed")]), "passed");
  assertEquals(decideIterationOutcome([resultWith("passed"), resultWith("failed")]), "failed");
  assertEquals(decideIterationOutcome([resultWith("failed"), resultWith("error")]), "error");
});

Deno.test("a Test Case compares the share of passed Iterations with its Pass Threshold", () => {
  assertEquals(decideTestCaseOutcome(["passed", "passed", "failed"], 0.66), "passed");
  assertEquals(decideTestCaseOutcome(["passed", "passed", "failed"], 0.67), "failed");
  assertEquals(decideTestCaseOutcome(["passed", "passed"], 1), "passed");
});

Deno.test("a persistent Error ends a Test Case as error even above its Pass Threshold", () => {
  assertEquals(decideTestCaseOutcome(["passed", "passed", "error"], 0.5), "error");
});

Deno.test("a run fails on any failure, and is otherwise an error on any Error", () => {
  assertEquals(decideRunVerdict(["passed", "error", "failed"]), "failed");
  assertEquals(decideRunVerdict(["passed", "error"]), "error");
  assertEquals(decideRunVerdict(["passed"]), "passed");
});
