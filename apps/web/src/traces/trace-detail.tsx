import type { Span, TraceDetailResponse } from "@evaluation-telemetry/contracts";
import { useEffect, useMemo, useState } from "react";
import { getTrace } from "../api/telemetry-api.ts";
import { buildSpanTreeRows } from "./span-tree.ts";
import { formatAttributeValue, formatDuration, millisecondsBetween } from "./trace-formatting.ts";

interface TraceDetailProps {
  apiKey: string;
  traceId: string;
  onClose: () => void;
}

type TraceDetailState =
  | { status: "loading" }
  | { status: "loaded"; trace: TraceDetailResponse }
  | { status: "failed"; message: string };

export function TraceDetail({ apiKey, traceId, onClose }: TraceDetailProps) {
  const [traceDetailState, setTraceDetailState] = useState<TraceDetailState>({ status: "loading" });
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  useEffect(() => {
    let isCurrentRequest = true;
    getTrace(apiKey, traceId)
      .then((trace) => {
        if (isCurrentRequest) {
          setTraceDetailState({ status: "loaded", trace });
          setSelectedSpanId(trace.spans[0]?.spanId ?? null);
        }
      })
      .catch((error: Error) => {
        if (isCurrentRequest) setTraceDetailState({ status: "failed", message: error.message });
      });
    return () => {
      isCurrentRequest = false;
    };
  }, [apiKey, traceId]);

  return (
    <section className="trace-detail-panel" aria-label="Trace detail">
      <header className="trace-detail-header">
        <div>
          <h2>Trace</h2>
          <code className="identifier-cell">{traceId}</code>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </header>
      {traceDetailState.status === "loading" && <p className="status-message">Loading spans…</p>}
      {traceDetailState.status === "failed" && (
        <p className="status-message status-message-error">{traceDetailState.message}</p>
      )}
      {traceDetailState.status === "loaded" && (
        <SpanWaterfall
          spans={traceDetailState.trace.spans}
          selectedSpanId={selectedSpanId}
          onSelectSpan={setSelectedSpanId}
        />
      )}
    </section>
  );
}

interface SpanWaterfallProps {
  spans: Span[];
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
}

function SpanWaterfall({ spans, selectedSpanId, onSelectSpan }: SpanWaterfallProps) {
  const treeRows = useMemo(() => buildSpanTreeRows(spans), [spans]);
  const traceStart = spans.reduce(
    (earliest, span) =>
      BigInt(span.startTimeUnixNano) < BigInt(earliest) ? span.startTimeUnixNano : earliest,
    spans[0].startTimeUnixNano,
  );
  const traceEnd = spans.reduce(
    (latest, span) => BigInt(span.endTimeUnixNano) > BigInt(latest) ? span.endTimeUnixNano : latest,
    spans[0].endTimeUnixNano,
  );
  const traceDurationMilliseconds = Math.max(millisecondsBetween(traceStart, traceEnd), 0.001);
  const selectedSpan = spans.find((span) => span.spanId === selectedSpanId) ?? null;

  return (
    <div className="span-waterfall-layout">
      <ol className="span-waterfall">
        {treeRows.map(({ span, depth }) => {
          const offsetPercent = (millisecondsBetween(traceStart, span.startTimeUnixNano) /
            traceDurationMilliseconds) * 100;
          const widthPercent = Math.max(
            (span.durationMilliseconds / traceDurationMilliseconds) * 100,
            0.5,
          );
          return (
            <li key={span.spanId}>
              <button
                type="button"
                className={`span-row${span.spanId === selectedSpanId ? " span-row-selected" : ""}`}
                onClick={() => onSelectSpan(span.spanId)}
              >
                <span className="span-name" style={{ paddingLeft: `${depth * 14}px` }}>
                  {span.statusCode === "error" && (
                    <span className="span-error-marker" aria-label="Error" />
                  )}
                  {span.name}
                </span>
                <span className="span-timeline">
                  <span
                    className={`span-bar span-bar-${span.kind}`}
                    style={{ left: `${offsetPercent}%`, width: `${widthPercent}%` }}
                  />
                </span>
                <span className="span-duration">{formatDuration(span.durationMilliseconds)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {selectedSpan !== null && <SpanAttributes span={selectedSpan} />}
    </div>
  );
}

function SpanAttributes({ span }: { span: Span }) {
  const summaryRows: [string, string][] = [
    ["Span ID", span.spanId],
    ["Kind", span.kind],
    ["Status", span.statusMessage ? `${span.statusCode}: ${span.statusMessage}` : span.statusCode],
    ["Duration", formatDuration(span.durationMilliseconds)],
    ["Correlation ID", span.correlationId],
    ["Session ID", span.sessionId ?? "—"],
  ];
  return (
    <div className="span-attributes">
      <h3>{span.name}</h3>
      <AttributeTable rows={summaryRows} />
      <h4>Attributes</h4>
      <AttributeTable
        rows={Object.entries(span.attributes).map((
          [key, value],
        ) => [key, formatAttributeValue(value)])}
      />
      <h4>Resource</h4>
      <AttributeTable
        rows={Object.entries(span.resourceAttributes).map((
          [key, value],
        ) => [key, formatAttributeValue(value)])}
      />
    </div>
  );
}

function AttributeTable({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) {
    return <p className="status-message">None</p>;
  }
  return (
    <dl className="attribute-table">
      {rows.map(([attributeName, attributeValue]) => (
        <div key={attributeName} className="attribute-row">
          <dt>{attributeName}</dt>
          <dd>{attributeValue}</dd>
        </div>
      ))}
    </dl>
  );
}
