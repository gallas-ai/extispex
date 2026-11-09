import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  MAXIMUM_MATCHED_SPAN_SUMMARIES,
  type Span,
  telemetryEvaluatorSchema,
} from "@extispex/contracts";
import { runTelemetryEvaluator } from "../src/evaluators/telemetry-evaluator.ts";

function createSpan(name: string, overrides: Partial<Span> = {}): Span {
  return {
    traceId: "trace",
    spanId: `span-${name}`,
    parentSpanId: null,
    name,
    kind: "internal",
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    durationMilliseconds: 1,
    statusCode: "ok",
    statusMessage: null,
    serviceName: null,
    correlationId: "correlation",
    sessionId: null,
    attributes: {},
    resourceAttributes: {},
    receivedAt: "2026-11-08T10:00:00.000Z",
    arrivedAfterEvaluation: false,
    ...overrides,
  };
}

function evaluate(evaluator: Record<string, unknown>, spans: Span[]) {
  return runTelemetryEvaluator(
    telemetryEvaluatorSchema.parse({ type: "telemetry", name: "check", ...evaluator }),
    spans,
  );
}

Deno.test("a span must meet every condition", () => {
  const spans = [
    createSpan("tool", { attributes: { tool: "lookup", retries: 2 } }),
    createSpan("tool", { attributes: { tool: "other", retries: 2 }, statusCode: "error" }),
  ];
  const countMatches = (match: Record<string, unknown>) =>
    evaluate({ match, count: { min: 0, max: 9 } }, spans).matchedSpanCount;
  assertEquals(countMatches({ name: "tool" }), 2);
  assertEquals(countMatches({ status: "error" }), 1);
  assertEquals(countMatches({ attributes: { tool: "lookup" } }), 1);
  assertEquals(countMatches({ name: "tool", status: "ok", attributes: { retries: 2 } }), 1);
  assertEquals(countMatches({ attributes: { retries: "2" } }), 0);
});

Deno.test("compares the number of matches with the expected count", () => {
  const spans = [createSpan("tool"), createSpan("tool")];
  const outcome = (count: Record<string, unknown>) =>
    evaluate({ match: { name: "tool" }, count }, spans).outcome;
  assertEquals(outcome({ min: 2 }), "passed");
  assertEquals(outcome({ min: 3 }), "failed");
  assertEquals(outcome({ min: 1, max: 1 }), "failed");
  assertEquals(outcome({ min: 1, max: 2 }), "passed");
});

Deno.test("a count of zero says that no span may match", () => {
  const forbidden = { match: { name: "delete_order" }, count: { min: 0, max: 0 } };
  assertEquals(evaluate(forbidden, [createSpan("tool")]).outcome, "passed");
  const result = evaluate(forbidden, [createSpan("delete_order")]);
  assertEquals(result.outcome, "failed");
  assertStringIncludes(result.reason, "expected exactly 0");
});

Deno.test("keeps a bounded summary and the full count", () => {
  const spans = Array.from(
    { length: MAXIMUM_MATCHED_SPAN_SUMMARIES + 5 },
    () => createSpan("tool"),
  );
  const result = evaluate({ match: { name: "tool" } }, spans);
  assertEquals(result.matchedSpanCount, spans.length);
  assertEquals(result.matchedSpans?.length, MAXIMUM_MATCHED_SPAN_SUMMARIES);
});
