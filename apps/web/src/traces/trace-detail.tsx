import type { Span, TraceDetailResponse } from "@extispex/contracts";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { getTrace } from "../api/telemetry-api.ts";
import { CopyButton } from "../ui/copy-button.tsx";
import { AlertIcon, CloseIcon, FilterIcon, HashIcon, SessionIcon } from "../ui/icons.tsx";
import { SpanDetails } from "./span-details.tsx";
import { buildSpanTreeRows } from "./span-tree.ts";
import { SpanWaterfall, type TraceTimeRange } from "./span-waterfall.tsx";
import {
  formatDuration,
  formatUnixNanoseconds,
  millisecondsBetween,
  shortenIdentifier,
} from "./trace-formatting.ts";
import type { ApiCredentials } from "../api/api-request.ts";

interface TraceDetailProps {
  credentials: ApiCredentials;
  traceId: string;
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
  onFilterBySession: (sessionId: string) => void;
  onFilterByCorrelationId: (correlationId: string) => void;
  onClose: () => void;
}

type TraceDetailState =
  | { status: "loading" }
  | { status: "loaded"; trace: TraceDetailResponse }
  | { status: "failed"; message: string };

export function TraceDetail(
  {
    credentials,
    traceId,
    selectedSpanId,
    onSelectSpan,
    onFilterBySession,
    onFilterByCorrelationId,
    onClose,
  }: TraceDetailProps,
) {
  const [traceDetailState, setTraceDetailState] = useState<TraceDetailState>({ status: "loading" });
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let isCurrentRequest = true;
    setTraceDetailState({ status: "loading" });
    getTrace(credentials, traceId)
      .then((trace) => {
        if (isCurrentRequest) setTraceDetailState({ status: "loaded", trace });
      })
      .catch((error: Error) => {
        if (isCurrentRequest) setTraceDetailState({ status: "failed", message: error.message });
      });
    return () => {
      isCurrentRequest = false;
    };
  }, [credentials, traceId, loadAttempt]);

  return (
    <section className="panel trace-detail-panel" aria-label="Trace detail">
      {traceDetailState.status === "loaded" && traceDetailState.trace.spans.length > 0
        ? (
          <LoadedTrace
            spans={traceDetailState.trace.spans}
            traceId={traceId}
            selectedSpanId={selectedSpanId}
            onSelectSpan={onSelectSpan}
            onFilterBySession={onFilterBySession}
            onFilterByCorrelationId={onFilterByCorrelationId}
            onClose={onClose}
          />
        )
        : (
          <>
            <TraceDetailHeader title="Trace" traceId={traceId} onClose={onClose} />
            <div className="trace-detail-body">
              {traceDetailState.status === "loading" && <TraceDetailSkeleton />}
              {traceDetailState.status === "failed" && (
                <div className="callout callout-danger" role="alert">
                  <AlertIcon size={16} />
                  <div>
                    <p>{traceDetailState.message}</p>
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      onClick={() =>
                        setLoadAttempt(loadAttempt + 1)}
                    >
                      Try again
                    </button>
                  </div>
                </div>
              )}
              {traceDetailState.status === "loaded" && (
                <p className="text-muted">This trace has no spans.</p>
              )}
            </div>
          </>
        )}
    </section>
  );
}

interface LoadedTraceProps {
  spans: Span[];
  traceId: string;
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
  onFilterBySession: (sessionId: string) => void;
  onFilterByCorrelationId: (correlationId: string) => void;
  onClose: () => void;
}

function LoadedTrace(
  {
    spans,
    traceId,
    selectedSpanId,
    onSelectSpan,
    onFilterBySession,
    onFilterByCorrelationId,
    onClose,
  }: LoadedTraceProps,
) {
  const treeRows = useMemo(() => buildSpanTreeRows(spans), [spans]);
  const timeRange = useMemo(() => measureTraceTimeRange(spans), [spans]);
  const rootSpan = treeRows[0].span;
  const selectedSpan = spans.find((span) => span.spanId === selectedSpanId) ?? rootSpan;
  const errorSpanCount = spans.filter((span) => span.statusCode === "error").length;
  const serviceNames = [...new Set(spans.map((span) => span.serviceName).filter(Boolean))];
  const hasRootSpan = rootSpan.parentSpanId === null;

  return (
    <>
      <TraceDetailHeader
        title={hasRootSpan ? rootSpan.name : "Root span not received"}
        traceId={traceId}
        onClose={onClose}
      />
      <div className="trace-detail-body">
        <dl className="stat-row">
          <Stat label="Duration" value={formatDuration(timeRange.durationMilliseconds)} />
          <Stat label="Spans" value={String(spans.length)} />
          <Stat
            label="Errors"
            value={String(errorSpanCount)}
            tone={errorSpanCount > 0 ? "danger" : undefined}
          />
          <Stat label="Started" value={formatUnixNanoseconds(timeRange.startUnixNanoseconds)} />
          {serviceNames.length > 0 && (
            <Stat label={serviceNames.length === 1 ? "Service" : "Services"}>
              <span className="badge-list">
                {serviceNames.map((serviceName) => (
                  <span key={serviceName} className="service-badge">{serviceName}</span>
                ))}
              </span>
            </Stat>
          )}
        </dl>

        <div className="identifier-cards">
          <IdentifierCard
            icon={<HashIcon size={14} />}
            label="Correlation ID"
            value={rootSpan.correlationId}
            filterLabel="Show traces with this Correlation ID"
            onFilter={() => onFilterByCorrelationId(rootSpan.correlationId)}
          />
          {rootSpan.sessionId !== null && (
            <IdentifierCard
              icon={<SessionIcon size={14} />}
              label="Session"
              value={rootSpan.sessionId}
              filterLabel="Show this Session's traces"
              onFilter={() => onFilterBySession(rootSpan.sessionId as string)}
            />
          )}
        </div>

        <SpanWaterfall
          treeRows={treeRows}
          timeRange={timeRange}
          selectedSpanId={selectedSpan.spanId}
          onSelectSpan={onSelectSpan}
        />

        <SpanDetails
          key={selectedSpan.spanId}
          span={selectedSpan}
          traceStartUnixNanoseconds={timeRange.startUnixNanoseconds}
        />
      </div>
    </>
  );
}

function TraceDetailHeader(
  { title, traceId, onClose }: { title: string; traceId: string; onClose: () => void },
) {
  return (
    <header className="trace-detail-header">
      <div className="trace-detail-title">
        <p className="eyebrow">Trace</p>
        <h2>{title}</h2>
        <span className="identifier-with-actions">
          <code className="text-muted" title={traceId}>{shortenIdentifier(traceId, 16)}</code>
          <CopyButton value={traceId} label="Trace ID" />
        </span>
      </div>
      <button
        type="button"
        className="icon-button close-button"
        onClick={onClose}
        aria-label="Close trace"
        title="Close (Esc)"
      >
        <CloseIcon size={18} />
      </button>
    </header>
  );
}

function Stat(
  { label, value, tone, children }: {
    label: string;
    value?: string;
    tone?: "danger";
    children?: ReactNode;
  },
) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <dt>{label}</dt>
      <dd>{children ?? value}</dd>
    </div>
  );
}

interface IdentifierCardProps {
  icon: ReactNode;
  label: string;
  value: string;
  filterLabel: string;
  onFilter: () => void;
}

function IdentifierCard({ icon, label, value, filterLabel, onFilter }: IdentifierCardProps) {
  return (
    <div className="identifier-card">
      <span className="identifier-card-icon">{icon}</span>
      <div className="identifier-card-text">
        <span className="identifier-card-label">{label}</span>
        <code className="identifier-card-value" title={value}>{value}</code>
      </div>
      <CopyButton value={value} label={label} />
      <button
        type="button"
        className="icon-button"
        onClick={onFilter}
        aria-label={filterLabel}
        title={filterLabel}
      >
        <FilterIcon size={14} />
      </button>
    </div>
  );
}

function TraceDetailSkeleton() {
  return (
    <div className="trace-detail-skeleton" aria-busy="true" aria-label="Loading spans">
      <div className="stat-row">
        {Array.from(
          { length: 4 },
          (_, statIndex) => <span key={statIndex} className="skeleton skeleton-stat" />,
        )}
      </div>
      {Array.from(
        { length: 5 },
        (_, rowIndex) => (
          <div key={rowIndex} className="skeleton-waterfall-row">
            <span className="skeleton skeleton-text" style={{ marginLeft: `${rowIndex * 12}px` }} />
            <span
              className="skeleton skeleton-bar"
              style={{ marginLeft: `${rowIndex * 9}%`, width: `${70 - rowIndex * 11}%` }}
            />
          </div>
        ),
      )}
    </div>
  );
}

function measureTraceTimeRange(spans: Span[]): TraceTimeRange {
  const startUnixNanoseconds = spans.reduce(
    (earliest, span) =>
      BigInt(span.startTimeUnixNano) < BigInt(earliest) ? span.startTimeUnixNano : earliest,
    spans[0].startTimeUnixNano,
  );
  const endUnixNanoseconds = spans.reduce(
    (latest, span) => BigInt(span.endTimeUnixNano) > BigInt(latest) ? span.endTimeUnixNano : latest,
    spans[0].endTimeUnixNano,
  );
  return {
    startUnixNanoseconds,
    durationMilliseconds: Math.max(
      millisecondsBetween(startUnixNanoseconds, endUnixNanoseconds),
      0.001,
    ),
  };
}
