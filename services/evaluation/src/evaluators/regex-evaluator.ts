import type { EvaluatorResult } from "@extispex/contracts";

/** Starting a thread is not the pattern's fault, so it has its own, generous limit. */
const WORKER_START_TIMEOUT_MILLISECONDS = 15_000;

export interface RegexEvaluation {
  name: string;
  pattern: string;
  flags: string;
  expectMatch: boolean;
  step?: number;
}

type WorkerMessage = { ready: true } | { matched: boolean };

/** The result of matching in a separate thread, which is terminated when the time is up. */
type MatchResult = { status: "matched" | "not_matched" } | { status: "error"; reason: string };

function matchInWorker(
  { pattern, flags }: RegexEvaluation,
  text: string,
  timeoutMilliseconds: number,
): Promise<MatchResult> {
  return new Promise((resolveMatch) => {
    const worker = new Worker(new URL("./regex-match-worker.ts", import.meta.url).href, {
      type: "module",
    });
    let timer: ReturnType<typeof setTimeout>;
    const finish = (matchResult: MatchResult) => {
      clearTimeout(timer);
      worker.terminate();
      resolveMatch(matchResult);
    };
    const failAfter = (milliseconds: number, reason: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ status: "error", reason }), milliseconds);
    };
    worker.onmessage = (messageEvent: MessageEvent<WorkerMessage>) => {
      if ("ready" in messageEvent.data) {
        // The time limit starts here, so that a busy machine does not fail a fast pattern.
        failAfter(
          timeoutMilliseconds,
          `The regular expression did not finish within ${timeoutMilliseconds} ms.`,
        );
        worker.postMessage({ pattern, flags, text });
        return;
      }
      finish({ status: messageEvent.data.matched ? "matched" : "not_matched" });
    };
    worker.onerror = (errorEvent) => {
      errorEvent.preventDefault();
      finish({ status: "error", reason: `The regular expression failed: ${errorEvent.message}` });
    };
    failAfter(WORKER_START_TIMEOUT_MILLISECONDS, "The evaluator's thread did not start in time.");
  });
}

/** Judges the Output as a string. A pattern that cannot finish is an Error, not a failure. */
export async function runRegexEvaluator(
  evaluator: RegexEvaluation,
  output: string,
  timeoutMilliseconds: number,
): Promise<EvaluatorResult> {
  const matchResult = await matchInWorker(evaluator, output, timeoutMilliseconds);
  const baseResult = { name: evaluator.name, type: "regex" as const };
  if (matchResult.status === "error") {
    return { ...baseResult, outcome: "error", reason: matchResult.reason };
  }
  const hasMatched = matchResult.status === "matched";
  const expression = `/${evaluator.pattern}/${evaluator.flags}`;
  const subject = evaluator.step === undefined
    ? "The Output"
    : `The Output of step ${evaluator.step}`;
  return {
    ...baseResult,
    outcome: hasMatched === evaluator.expectMatch ? "passed" : "failed",
    reason: hasMatched
      ? `${subject} matches ${expression}.`
      : `${subject} does not match ${expression}.`,
  };
}
