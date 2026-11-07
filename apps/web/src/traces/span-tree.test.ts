/// <reference lib="deno.ns" />
import type { Span } from "@extispex/contracts";
import { assertEquals } from "@std/assert";
import { buildSpanTreeRows, hideCollapsedSubtrees } from "./span-tree.ts";

function createSpan(spanId: string, parentSpanId: string | null, startTimeUnixNano: string): Span {
  return {
    traceId: "trace",
    spanId,
    parentSpanId,
    name: spanId,
    kind: "internal",
    startTimeUnixNano,
    endTimeUnixNano: startTimeUnixNano,
    durationMilliseconds: 0,
    statusCode: "unset",
    statusMessage: null,
    serviceName: null,
    correlationId: "correlation",
    sessionId: null,
    attributes: {},
    resourceAttributes: {},
  };
}

const conversationSpans = [
  createSpan("tool-call", "root", "30"),
  createSpan("model-call", "root", "20"),
  createSpan("root", null, "10"),
  createSpan("retrieval", "model-call", "25"),
];

Deno.test("span tree rows put parents first, order siblings by start and count children", () => {
  const treeRows = buildSpanTreeRows(conversationSpans);
  assertEquals(
    treeRows.map(({ span, depth, childCount }) => [span.spanId, depth, childCount]),
    [["root", 0, 2], ["model-call", 1, 1], ["retrieval", 2, 0], ["tool-call", 1, 0]],
  );
});

Deno.test("a span whose parent has not arrived is shown at the top level", () => {
  const treeRows = buildSpanTreeRows([createSpan("orphan", "missing-parent", "10")]);
  assertEquals(treeRows.map(({ span, depth }) => [span.spanId, depth]), [["orphan", 0]]);
});

Deno.test("collapsing a span hides its descendants but keeps its siblings", () => {
  const treeRows = buildSpanTreeRows(conversationSpans);
  const visibleSpanIds = hideCollapsedSubtrees(treeRows, new Set(["model-call"])).map((row) =>
    row.span.spanId
  );
  assertEquals(visibleSpanIds, ["root", "model-call", "tool-call"]);
});

Deno.test("collapsing the root hides every other span", () => {
  const treeRows = buildSpanTreeRows(conversationSpans);
  assertEquals(hideCollapsedSubtrees(treeRows, new Set(["root"])).length, 1);
});
