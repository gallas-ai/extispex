import type { Span } from "@extispex/contracts";

export interface SpanTreeRow {
  span: Span;
  depth: number;
  childCount: number;
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
      const childCount = childrenByParentId.get(childSpan.spanId)?.length ?? 0;
      treeRows.push({ span: childSpan, depth, childCount });
      appendSubtree(childSpan.spanId, depth + 1);
    }
  };
  appendSubtree(null, 0);
  return treeRows;
}

/** Drops the descendants of collapsed spans, keeping the collapsed spans themselves. */
export function hideCollapsedSubtrees(
  treeRows: SpanTreeRow[],
  collapsedSpanIds: ReadonlySet<string>,
): SpanTreeRow[] {
  const visibleRows: SpanTreeRow[] = [];
  let hiddenBelowDepth: number | null = null;
  for (const treeRow of treeRows) {
    if (hiddenBelowDepth !== null && treeRow.depth > hiddenBelowDepth) {
      continue;
    }
    hiddenBelowDepth = null;
    visibleRows.push(treeRow);
    if (collapsedSpanIds.has(treeRow.span.spanId)) {
      hiddenBelowDepth = treeRow.depth;
    }
  }
  return visibleRows;
}
