import type { TraceSummary } from "@extispex/contracts";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import { CopyButton } from "../ui/copy-button.tsx";
import { FilterIcon } from "../ui/icons.tsx";
import { useNow } from "../ui/use-now.ts";
import {
  formatDuration,
  formatRelativeTime,
  formatUnixNanoseconds,
  shortenIdentifier,
  unixNanosecondsToMilliseconds,
} from "./trace-formatting.ts";

const RELATIVE_TIME_REFRESH_MILLISECONDS = 15_000;

interface TraceTableProps {
  traces: TraceSummary[];
  selectedTraceId: string | null;
  onSelectTrace: (traceId: string) => void;
  onFilterBySession: (sessionId: string) => void;
}

export function TraceTable(
  { traces, selectedTraceId, onSelectTrace, onFilterBySession }: TraceTableProps,
) {
  const nowUnixMilliseconds = useNow(RELATIVE_TIME_REFRESH_MILLISECONDS);
  const longestDurationMilliseconds = Math.max(
    ...traces.map((trace) => trace.durationMilliseconds),
    0.001,
  );
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);

  // Keyboard selection elsewhere (j and k) should keep the selected row in view.
  useEffect(() => {
    tableBodyRef.current?.querySelector(".trace-row-selected")?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedTraceId]);

  const moveFocusBetweenRows = (keyboardEvent: KeyboardEvent<HTMLTableRowElement>) => {
    const nextRow = keyboardEvent.key === "ArrowDown"
      ? keyboardEvent.currentTarget.nextElementSibling
      : keyboardEvent.key === "ArrowUp"
      ? keyboardEvent.currentTarget.previousElementSibling
      : null;
    if (nextRow instanceof HTMLTableRowElement) {
      keyboardEvent.preventDefault();
      nextRow.focus();
      // With a trace open, moving through the list shows each trace, like an email client.
      if (selectedTraceId !== null && nextRow.dataset.traceId) {
        onSelectTrace(nextRow.dataset.traceId);
      }
    }
  };

  return (
    <div className="table-scroll">
      <table className="data-table trace-table">
        <thead>
          <tr>
            <th scope="col">Trace</th>
            <th scope="col" className="column-session">Session</th>
            <th scope="col" className="column-correlation">Correlation ID</th>
            <th scope="col" className="column-numeric column-spans">Spans</th>
            <th scope="col" className="column-numeric">Duration</th>
            <th scope="col" className="column-numeric column-started">Started</th>
          </tr>
        </thead>
        <tbody ref={tableBodyRef}>
          {traces.map((trace) => {
            const isSelected = trace.traceId === selectedTraceId;
            const startUnixMilliseconds = unixNanosecondsToMilliseconds(trace.startTimeUnixNano);
            return (
              <tr
                key={trace.traceId}
                data-trace-id={trace.traceId}
                className={`trace-row${isSelected ? " trace-row-selected" : ""}`}
                tabIndex={0}
                aria-selected={isSelected}
                onClick={() => onSelectTrace(trace.traceId)}
                onKeyDown={(keyboardEvent) => {
                  if (keyboardEvent.target !== keyboardEvent.currentTarget) return;
                  if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
                    keyboardEvent.preventDefault();
                    onSelectTrace(trace.traceId);
                  } else {
                    moveFocusBetweenRows(keyboardEvent);
                  }
                }}
              >
                <td className="trace-cell">
                  <span className="trace-cell-name">
                    {trace.rootSpanName ?? (
                      <span className="text-subtle">Root span not received</span>
                    )}
                  </span>
                  <span className="trace-cell-meta">
                    {trace.serviceName && (
                      <span className="service-badge">{trace.serviceName}</span>
                    )}
                    <code className="text-subtle">{shortenIdentifier(trace.traceId)}</code>
                  </span>
                </td>
                <td className="column-session">
                  {trace.sessionId === null
                    ? <span className="text-subtle">—</span>
                    : (
                      <span className="identifier-with-actions">
                        <code className="identifier" title={trace.sessionId}>
                          {trace.sessionId}
                        </code>
                        <button
                          type="button"
                          className="icon-button reveal-on-row-hover"
                          onClick={(clickEvent: MouseEvent) => {
                            clickEvent.stopPropagation();
                            onFilterBySession(trace.sessionId as string);
                          }}
                          aria-label="Show this Session's traces"
                          title="Show this Session's traces"
                        >
                          <FilterIcon size={13} />
                        </button>
                      </span>
                    )}
                </td>
                <td className="column-correlation">
                  <span className="identifier-with-actions">
                    <code className="identifier" title={trace.correlationId}>
                      {trace.correlationId}
                    </code>
                    <CopyButton
                      value={trace.correlationId}
                      label="Correlation ID"
                      className="reveal-on-row-hover"
                    />
                  </span>
                </td>
                <td className="column-numeric column-spans">{trace.spanCount}</td>
                <td className="column-numeric">
                  <span className="duration-cell">
                    {formatDuration(trace.durationMilliseconds)}
                    <span className="duration-meter" aria-hidden="true">
                      <span
                        style={{
                          width: `${
                            Math.max(
                              (trace.durationMilliseconds / longestDurationMilliseconds) * 100,
                              2,
                            )
                          }%`,
                        }}
                      />
                    </span>
                  </span>
                </td>
                <td
                  className="column-numeric column-started text-muted"
                  title={formatUnixNanoseconds(trace.startTimeUnixNano)}
                >
                  <time dateTime={new Date(startUnixMilliseconds).toISOString()}>
                    {formatRelativeTime(startUnixMilliseconds, nowUnixMilliseconds)}
                  </time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TraceTableSkeleton() {
  return (
    <div className="table-scroll" aria-busy="true" aria-label="Loading traces">
      <table className="data-table trace-table">
        <thead>
          <tr>
            <th scope="col">Trace</th>
            <th scope="col" className="column-session">Session</th>
            <th scope="col" className="column-correlation">Correlation ID</th>
            <th scope="col" className="column-numeric column-spans">Spans</th>
            <th scope="col" className="column-numeric">Duration</th>
            <th scope="col" className="column-numeric column-started">Started</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, rowIndex) => (
            <tr key={rowIndex} className="skeleton-row">
              <td>
                <span className="skeleton skeleton-text-wide" />
                <span className="skeleton skeleton-text-narrow" />
              </td>
              <td className="column-session">
                <span className="skeleton skeleton-text" />
              </td>
              <td className="column-correlation">
                <span className="skeleton skeleton-text" />
              </td>
              <td className="column-numeric column-spans">
                <span className="skeleton skeleton-number" />
              </td>
              <td className="column-numeric">
                <span className="skeleton skeleton-number" />
              </td>
              <td className="column-numeric column-started">
                <span className="skeleton skeleton-number" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
