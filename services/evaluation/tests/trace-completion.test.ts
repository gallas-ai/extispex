import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideTraceCompletion,
  DEFAULT_TRACE_COMPLETION_TIMING,
} from "../src/iterations/trace-completion.ts";

const READ_AT = "2026-11-08T10:00:30.000Z";

function secondsBeforeRead(seconds: number): string {
  return new Date(Date.parse(READ_AT) - seconds * 1_000).toISOString();
}

function decide(rootSpanAges: (number | null)[], secondsSinceOutput: number) {
  return decideTraceCompletion(
    {
      readAt: READ_AT,
      firstReceivedAt: READ_AT,
      traces: rootSpanAges.map((age, index) => ({
        traceId: `trace-${index}`,
        rootSpanStoredAt: age === null ? null : secondsBeforeRead(age),
      })),
    },
    secondsSinceOutput * 1_000,
    DEFAULT_TRACE_COMPLETION_TIMING,
  );
}

Deno.test("a trace is complete 10 seconds after its root span was stored", () => {
  assertEquals(decide([9], 20).status, "waiting");
  assertEquals(decide([10], 20).status, "complete");
});

Deno.test("every trace of a retried operation needs a settled root span", () => {
  assertEquals(decide([30, 2], 40).status, "waiting");
  assertEquals(decide([30, null], 40).status, "waiting");
  assertEquals(decide([30, 12], 40).status, "complete");
});

Deno.test("a root span that arrives just in time still settles after the timeout", () => {
  assertEquals(decide([1], 61).status, "waiting");
  assertEquals(decide([11], 71).status, "complete");
});

Deno.test("gives up 60 seconds after the Output without a root span", () => {
  assertEquals(decide([null], 59).status, "waiting");
  const timedOut = decide([null], 60);
  assertEquals(timedOut.status, "timed_out");
  if (timedOut.status === "timed_out") assertStringIncludes(timedOut.reason, "No root span");
  const nothing = decide([], 60);
  if (nothing.status === "timed_out") assertStringIncludes(nothing.reason, "No telemetry");
});
