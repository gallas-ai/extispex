import type { Span } from "@evaluation-telemetry/contracts";

export interface SpanTreeRow {
  span: Span;
  depth: number;
}

/**
 * Orders spans depth first, parents before children, siblings by start time. Spans whose parent
 * has not arrived are shown at the top level.
 */
export function buildSpanTreeRows(spans: Span[]): SpanTreeRow[] {
  const spanIds = new Set(spans.map((span) => span.spanId));
  const childrenByParentId = new Map<string | null, Span[]>();
  for (const span of spans) {
    const parentKey = span.parentSpanId !== null && spanIds.has(span.parentSpanId)
      ? span.parentSpanId
      : null;
    const siblings = childrenByParentId.get(parentKey) ?? [];
    siblings.push(span);
    childrenByParentId.set(parentKey, siblings);
  }
  for (const siblings of childrenByParentId.values()) {
    siblings.sort((firstSpan, secondSpan) =>
      BigInt(firstSpan.startTimeUnixNano) < BigInt(secondSpan.startTimeUnixNano) ? -1 : 1
    );
  }

  const treeRows: SpanTreeRow[] = [];
  const appendSubtree = (parentKey: string | null, depth: number) => {
    for (const childSpan of childrenByParentId.get(parentKey) ?? []) {
      treeRows.push({ span: childSpan, depth });
      appendSubtree(childSpan.spanId, depth + 1);
    }
  };
  appendSubtree(null, 0);
  return treeRows;
}
