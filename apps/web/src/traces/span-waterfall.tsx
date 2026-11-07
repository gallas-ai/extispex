import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, SparklesIcon, WrenchIcon } from "../ui/icons.tsx";
import { summarizeGenAiSpan } from "./gen-ai-attributes.ts";
import { hideCollapsedSubtrees, type SpanTreeRow } from "./span-tree.ts";
import { buildTimeAxisTicks, formatDuration, millisecondsBetween } from "./trace-formatting.ts";

export interface TraceTimeRange {
  startUnixNanoseconds: string;
  durationMilliseconds: number;
}

interface SpanWaterfallProps {
  treeRows: SpanTreeRow[];
  timeRange: TraceTimeRange;
  selectedSpanId: string;
  onSelectSpan: (spanId: string) => void;
}

/** Bars narrower than this are widened so that very short spans stay visible and clickable. */
const MINIMUM_BAR_WIDTH_PERCENT = 0.6;

export function SpanWaterfall(
  { treeRows, timeRange, selectedSpanId, onSelectSpan }: SpanWaterfallProps,
) {
  const [collapsedSpanIds, setCollapsedSpanIds] = useState<ReadonlySet<string>>(new Set());
  const visibleRows = useMemo(
    () => hideCollapsedSubtrees(treeRows, collapsedSpanIds),
    [treeRows, collapsedSpanIds],
  );
  const timeAxisTicks = buildTimeAxisTicks(timeRange.durationMilliseconds);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const selectedRow = treeRef.current?.querySelector<HTMLElement>("[aria-selected='true']");
    if (selectedRow && treeRef.current?.contains(document.activeElement)) selectedRow.focus();
  }, [selectedSpanId]);

  const toggleCollapsed = (spanId: string) => {
    const nextCollapsedSpanIds = new Set(collapsedSpanIds);
    if (nextCollapsedSpanIds.has(spanId)) {
      nextCollapsedSpanIds.delete(spanId);
    } else {
      nextCollapsedSpanIds.add(spanId);
    }
    setCollapsedSpanIds(nextCollapsedSpanIds);
  };

  /** Arrow keys follow the WAI-ARIA tree pattern: up and down move, left and right fold. */
  const navigateTree = (keyboardEvent: KeyboardEvent) => {
    const selectedIndex = visibleRows.findIndex((row) => row.span.spanId === selectedSpanId);
    if (selectedIndex === -1) return;
    const selectedRow = visibleRows[selectedIndex];
    const isCollapsed = collapsedSpanIds.has(selectedRow.span.spanId);
    let handled = true;
    if (keyboardEvent.key === "ArrowDown") {
      const nextRow = visibleRows[selectedIndex + 1];
      if (nextRow) onSelectSpan(nextRow.span.spanId);
    } else if (keyboardEvent.key === "ArrowUp") {
      const previousRow = visibleRows[selectedIndex - 1];
      if (previousRow) onSelectSpan(previousRow.span.spanId);
    } else if (keyboardEvent.key === "ArrowRight" && selectedRow.childCount > 0) {
      if (isCollapsed) toggleCollapsed(selectedRow.span.spanId);
    } else if (keyboardEvent.key === "ArrowLeft") {
      if (selectedRow.childCount > 0 && !isCollapsed) {
        toggleCollapsed(selectedRow.span.spanId);
      } else {
        const parentRow = visibleRows.slice(0, selectedIndex).findLast((row) =>
          row.depth === selectedRow.depth - 1
        );
        if (parentRow) onSelectSpan(parentRow.span.spanId);
      }
    } else {
      handled = false;
    }
    if (handled) keyboardEvent.preventDefault();
  };

  return (
    <div className="waterfall">
      <div className="waterfall-header" aria-hidden="true">
        <span>Span</span>
        <span className="time-axis">
          {timeAxisTicks.map((tick) => (
            <span
              key={tick.offsetPercent}
              className="time-axis-tick"
              style={{ left: `${tick.offsetPercent}%` }}
            >
              {tick.label}
            </span>
          ))}
        </span>
        <span className="waterfall-duration-heading">Duration</span>
      </div>
      <div
        className="waterfall-rows"
        role="tree"
        aria-label="Spans"
        ref={treeRef}
        onKeyDown={navigateTree}
      >
        {visibleRows.map(({ span, depth, childCount }) => {
          const isSelected = span.spanId === selectedSpanId;
          const isCollapsed = collapsedSpanIds.has(span.spanId);
          const genAiSummary = summarizeGenAiSpan(span.attributes);
          const offsetPercent = (millisecondsBetween(
            timeRange.startUnixNanoseconds,
            span.startTimeUnixNano,
          ) / timeRange.durationMilliseconds) * 100;
          const widthPercent = Math.max(
            (span.durationMilliseconds / timeRange.durationMilliseconds) * 100,
            MINIMUM_BAR_WIDTH_PERCENT,
          );
          return (
            <div
              key={span.spanId}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={isSelected}
              aria-expanded={childCount > 0 ? !isCollapsed : undefined}
              tabIndex={isSelected ? 0 : -1}
              className={`waterfall-row${isSelected ? " waterfall-row-selected" : ""}${
                span.statusCode === "error" ? " waterfall-row-error" : ""
              }`}
              onClick={() => onSelectSpan(span.spanId)}
            >
              <span className="waterfall-label">
                {Array.from(
                  { length: depth },
                  (_, guideIndex) => (
                    <span key={guideIndex} className="tree-guide" aria-hidden="true" />
                  ),
                )}
                {childCount > 0
                  ? (
                    <span
                      className={`tree-toggle${isCollapsed ? "" : " tree-toggle-open"}`}
                      onClick={(clickEvent) => {
                        clickEvent.stopPropagation();
                        toggleCollapsed(span.spanId);
                      }}
                      aria-hidden="true"
                      title={isCollapsed ? `Show ${childCount} child spans` : "Hide child spans"}
                    >
                      <ChevronRightIcon size={13} />
                    </span>
                  )
                  : <span className="tree-toggle-spacer" aria-hidden="true" />}
                <span className={`kind-dot kind-${span.kind}`} aria-hidden="true" />
                <span className="waterfall-span-name" title={span.name}>{span.name}</span>
                {genAiSummary.model !== null && (
                  <span
                    className="span-badge span-badge-model"
                    title={`Model: ${genAiSummary.model}`}
                  >
                    <SparklesIcon size={11} />
                    {genAiSummary.model}
                  </span>
                )}
                {genAiSummary.toolName !== null && (
                  <span
                    className="span-badge span-badge-tool"
                    title={`Tool: ${genAiSummary.toolName}`}
                  >
                    <WrenchIcon size={11} />
                    {genAiSummary.toolName}
                  </span>
                )}
                {span.statusCode === "error" && (
                  <span className="span-badge span-badge-error">Error</span>
                )}
                {isCollapsed && <span className="span-badge span-badge-count">+{childCount}</span>}
              </span>
              <span className="waterfall-track">
                <span
                  className={`waterfall-bar kind-${span.kind}`}
                  style={{
                    left: `${Math.min(offsetPercent, 100 - widthPercent)}%`,
                    width: `${widthPercent}%`,
                  }}
                />
              </span>
              <span className="waterfall-duration">
                {formatDuration(span.durationMilliseconds)}
              </span>
            </div>
          );
        })}
      </div>
      <SpanKindLegend kinds={[...new Set(treeRows.map((row) => row.span.kind))]} />
    </div>
  );
}

function SpanKindLegend({ kinds }: { kinds: string[] }) {
  return (
    <p className="waterfall-legend">
      {kinds.map((kind) => (
        <span key={kind} className="legend-item">
          <span className={`kind-dot kind-${kind}`} aria-hidden="true" />
          {kind}
        </span>
      ))}
      <span className="waterfall-legend-hint">
        <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>←</kbd> <kbd>→</kbd> fold
      </span>
    </p>
  );
}
