import type { EvaluatorResult, IterationStatus, Verdict } from "@extispex/contracts";

/** An Iteration passes only if all of its Evaluators pass. An Error says nothing about quality. */
export function decideIterationOutcome(evaluatorResults: EvaluatorResult[]): Verdict {
  const outcomes = evaluatorResults.map((result) => result.outcome);
  if (outcomes.includes("error")) return "error";
  return outcomes.includes("failed") ? "failed" : "passed";
}

/**
 * A persistent Error ends the Test Case as `error`. Otherwise the share of passed Iterations must
 * reach the Pass Threshold.
 */
export function decideTestCaseOutcome(
  iterationStatuses: IterationStatus[],
  passThreshold: number,
): Verdict {
  if (iterationStatuses.includes("error")) return "error";
  const passedCount = iterationStatuses.filter((status) => status === "passed").length;
  return passedCount / iterationStatuses.length >= passThreshold ? "passed" : "failed";
}

/** A known failure says more than an Error, and neither is a successful run. */
export function decideRunVerdict(testCaseOutcomes: Verdict[]): Verdict {
  if (testCaseOutcomes.includes("failed")) return "failed";
  return testCaseOutcomes.includes("error") ? "error" : "passed";
}
