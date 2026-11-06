import type { TraceSummary } from "@evaluation-telemetry/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { listTraces, type TraceFilters } from "../api/telemetry-api.ts";
import { formatDuration, formatUnixNanoseconds } from "./trace-formatting.ts";
import { TraceDetail } from "./trace-detail.tsx";

interface TracesPageProps {
  apiKey: string;
}

type TraceListState =
  | { status: "loading" }
  | { status: "loaded"; traces: TraceSummary[] }
  | { status: "failed"; message: string };

const EMPTY_FILTERS: TraceFilters = { correlationId: "", sessionId: "" };

export function TracesPage({ apiKey }: TracesPageProps) {
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS);
  const [traceListState, setTraceListState] = useState<TraceListState>({ status: "loading" });
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const loadTraces = useCallback(async () => {
    setTraceListState({ status: "loading" });
    try {
      const { traces } = await listTraces(apiKey, appliedFilters);
      setTraceListState({ status: "loaded", traces });
    } catch (error) {
      setTraceListState({ status: "failed", message: (error as Error).message });
    }
  }, [apiKey, appliedFilters]);

  useEffect(() => {
    loadTraces();
  }, [loadTraces]);

  const applyFilters = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setSelectedTraceId(null);
    setAppliedFilters({
      correlationId: draftFilters.correlationId.trim(),
      sessionId: draftFilters.sessionId.trim(),
    });
  };

  return (
    <div className="traces-layout">
      <section className="trace-list-panel" aria-label="Traces">
        <form className="trace-filters" onSubmit={applyFilters}>
          <label>
            Correlation ID
            <input
              id="correlation-id-filter"
              value={draftFilters.correlationId}
              onChange={(changeEvent) =>
                setDraftFilters({ ...draftFilters, correlationId: changeEvent.target.value })}
            />
          </label>
          <label>
            Session ID
            <input
              id="session-id-filter"
              value={draftFilters.sessionId}
              onChange={(changeEvent) =>
                setDraftFilters({ ...draftFilters, sessionId: changeEvent.target.value })}
            />
          </label>
          <button type="submit">Search</button>
          <button type="button" className="secondary-button" onClick={loadTraces}>Refresh</button>
        </form>
        <TraceTable
          traceListState={traceListState}
          selectedTraceId={selectedTraceId}
          onSelectTrace={setSelectedTraceId}
        />
      </section>
      {selectedTraceId !== null && (
        <TraceDetail
          key={selectedTraceId}
          apiKey={apiKey}
          traceId={selectedTraceId}
          onClose={() => setSelectedTraceId(null)}
        />
      )}
    </div>
  );
}

interface TraceTableProps {
  traceListState: TraceListState;
  selectedTraceId: string | null;
  onSelectTrace: (traceId: string) => void;
}

function TraceTable({ traceListState, selectedTraceId, onSelectTrace }: TraceTableProps) {
  if (traceListState.status === "loading") {
    return <p className="status-message">Loading traces…</p>;
  }
  if (traceListState.status === "failed") {
    return <p className="status-message status-message-error">{traceListState.message}</p>;
  }
  if (traceListState.traces.length === 0) {
    return (
      <p className="status-message">
        No traces match. Send spans with a <code>correlation.id</code>{" "}
        attribute to OTLP port 4318 or 4317.
      </p>
    );
  }
  return (
    <div className="table-scroll">
      <table className="trace-table">
        <thead>
          <tr>
            <th>Trace</th>
            <th>Service</th>
            <th>Correlation ID</th>
            <th>Session ID</th>
            <th className="numeric-column">Spans</th>
            <th className="numeric-column">Duration</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {traceListState.traces.map((trace) => (
            <tr
              key={trace.traceId}
              className={trace.traceId === selectedTraceId ? "selected-row" : undefined}
              onClick={() => onSelectTrace(trace.traceId)}
            >
              <td>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onSelectTrace(trace.traceId)}
                >
                  {trace.rootSpanName ?? "Root span not received"}
                </button>
              </td>
              <td>{trace.serviceName ?? "—"}</td>
              <td className="identifier-cell">{trace.correlationId}</td>
              <td className="identifier-cell">{trace.sessionId ?? "—"}</td>
              <td className="numeric-column">{trace.spanCount}</td>
              <td className="numeric-column">{formatDuration(trace.durationMilliseconds)}</td>
              <td>{formatUnixNanoseconds(trace.startTimeUnixNano)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
