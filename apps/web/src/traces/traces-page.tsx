import type { TraceSummary } from "@extispex/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isApiKeyRejection } from "../api/api-request.ts";
import { listTraces, type TraceFilters } from "../api/telemetry-api.ts";
import { useTracesUrlState } from "../navigation/traces-url-state.ts";
import { InboxIcon, RefreshIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useNow } from "../ui/use-now.ts";
import { TraceDetail } from "./trace-detail.tsx";
import { TraceFilterBar } from "./trace-filters.tsx";
import { formatRelativeTime } from "./trace-formatting.ts";
import { TraceTable, TraceTableSkeleton } from "./trace-table.tsx";

const LIVE_REFRESH_INTERVAL_MILLISECONDS = 5_000;

interface TracesPageProps {
  apiKey: string;
  onDisconnect: () => void;
}

type TraceListState =
  | { status: "loading" }
  | { status: "loaded"; traces: TraceSummary[]; loadedAtUnixMilliseconds: number }
  | { status: "failed"; message: string; isApiKeyRejected: boolean };

export function TracesPage({ apiKey, onDisconnect }: TracesPageProps) {
  const [urlState, updateUrlState] = useTracesUrlState();
  const appliedFilters = useMemo<TraceFilters>(
    () => ({ correlationId: urlState.correlationId, sessionId: urlState.sessionId }),
    [urlState.correlationId, urlState.sessionId],
  );
  const [traceListState, setTraceListState] = useState<TraceListState>({ status: "loading" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const latestRequestNumber = useRef(0);
  const correlationIdInputRef = useRef<HTMLInputElement>(null);

  const loadTraces = useCallback(async (keepCurrentRows: boolean) => {
    const requestNumber = ++latestRequestNumber.current;
    if (keepCurrentRows) {
      setIsRefreshing(true);
    } else {
      setTraceListState({ status: "loading" });
    }
    try {
      const { traces } = await listTraces(apiKey, appliedFilters);
      if (requestNumber !== latestRequestNumber.current) return;
      setTraceListState({ status: "loaded", traces, loadedAtUnixMilliseconds: Date.now() });
    } catch (error) {
      if (requestNumber !== latestRequestNumber.current) return;
      setTraceListState({
        status: "failed",
        message: (error as Error).message,
        isApiKeyRejected: isApiKeyRejection(error),
      });
    } finally {
      if (requestNumber === latestRequestNumber.current) setIsRefreshing(false);
    }
  }, [apiKey, appliedFilters]);

  useEffect(() => {
    loadTraces(false);
  }, [loadTraces]);

  useEffect(() => {
    if (!isLive) return;
    const liveRefreshTimer = setInterval(
      () => loadTraces(true),
      LIVE_REFRESH_INTERVAL_MILLISECONDS,
    );
    return () => clearInterval(liveRefreshTimer);
  }, [isLive, loadTraces]);

  const loadedTraces = traceListState.status === "loaded" ? traceListState.traces : [];

  const selectTrace = useCallback(
    (traceId: string) => {
      if (traceId === urlState.traceId) return;
      // Replacing while a trace is open keeps Back meaning "close the trace", not "previous one".
      updateUrlState({ traceId, spanId: null }, urlState.traceId === null ? "push" : "replace");
    },
    [updateUrlState, urlState.traceId],
  );
  const closeTrace = useCallback(
    () => updateUrlState({ traceId: null, spanId: null }, "push"),
    [updateUrlState],
  );
  const applyFilters = useCallback(
    (filters: TraceFilters) => updateUrlState({ ...filters, traceId: null, spanId: null }, "push"),
    [updateUrlState],
  );

  useTracesKeyboardShortcuts({
    traces: loadedTraces,
    selectedTraceId: urlState.traceId,
    onSelectTrace: selectTrace,
    onCloseTrace: closeTrace,
    onFocusSearch: () => correlationIdInputRef.current?.focus(),
  });

  const hasAppliedFilters = appliedFilters.correlationId !== "" || appliedFilters.sessionId !== "";

  return (
    <div className={`traces-page${urlState.traceId !== null ? " traces-page-with-detail" : ""}`}>
      <div className="page-header">
        <div className="page-heading">
          <h1>Traces</h1>
          <TraceCountSummary traceListState={traceListState} hasFilters={hasAppliedFilters} />
        </div>
        <div className="page-actions">
          <LastUpdated traceListState={traceListState} />
          <label className="toggle" title="Refresh every 5 seconds">
            <input
              type="checkbox"
              role="switch"
              checked={isLive}
              onChange={(changeEvent) =>
                setIsLive(changeEvent.target.checked)}
            />
            <span className="toggle-track" aria-hidden="true">
              <span className="toggle-thumb" />
            </span>
            <span className="toggle-label">
              {isLive && <span className="live-dot" aria-hidden="true" />}
              Live
            </span>
          </label>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => loadTraces(traceListState.status === "loaded")}
            disabled={isRefreshing || traceListState.status === "loading"}
          >
            <RefreshIcon size={14} className={isRefreshing ? "spinning" : undefined} />
            Refresh
          </button>
        </div>
      </div>

      <TraceFilterBar
        appliedFilters={appliedFilters}
        onApplyFilters={applyFilters}
        correlationIdInputRef={correlationIdInputRef}
      />

      <div className="traces-workspace">
        <section className="panel trace-list-panel" aria-label="Trace list">
          {traceListState.status === "loading" && <TraceTableSkeleton />}
          {traceListState.status === "failed" && (
            <LoadError
              subject="Traces"
              message={traceListState.message}
              isApiKeyRejected={traceListState.isApiKeyRejected}
              onRetry={() => loadTraces(false)}
              onDisconnect={onDisconnect}
            />
          )}
          {traceListState.status === "loaded" && traceListState.traces.length === 0 && (
            <EmptyState
              hasFilters={hasAppliedFilters}
              onClearFilters={() => applyFilters({ correlationId: "", sessionId: "" })}
            />
          )}
          {traceListState.status === "loaded" && traceListState.traces.length > 0 && (
            <>
              <TraceTable
                traces={traceListState.traces}
                selectedTraceId={urlState.traceId}
                onSelectTrace={selectTrace}
                onFilterBySession={(sessionId) => applyFilters({ correlationId: "", sessionId })}
              />
              <p className="table-footer">
                <span>
                  <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close ·
                  {" "}
                  <kbd>/</kbd> search
                </span>
              </p>
            </>
          )}
        </section>

        {urlState.traceId !== null && (
          <>
            <div className="drawer-backdrop" onClick={closeTrace} aria-hidden="true" />
            <TraceDetail
              key={urlState.traceId}
              apiKey={apiKey}
              traceId={urlState.traceId}
              selectedSpanId={urlState.spanId}
              onSelectSpan={(spanId) => updateUrlState({ spanId }, "replace")}
              onFilterBySession={(sessionId) => applyFilters({ correlationId: "", sessionId })}
              onFilterByCorrelationId={(correlationId) =>
                applyFilters({ correlationId, sessionId: "" })}
              onClose={closeTrace}
            />
          </>
        )}
      </div>
    </div>
  );
}

function TraceCountSummary(
  { traceListState, hasFilters }: { traceListState: TraceListState; hasFilters: boolean },
) {
  if (traceListState.status !== "loaded") {
    return <p className="page-subtitle">&nbsp;</p>;
  }
  const traceCount = traceListState.traces.length;
  return (
    <p className="page-subtitle">
      {traceCount === 1 ? "1 trace" : `${traceCount} traces`}
      {hasFilters ? " matching the filters" : ", newest first"}
    </p>
  );
}

function LastUpdated({ traceListState }: { traceListState: TraceListState }) {
  const nowUnixMilliseconds = useNow(5_000);
  if (traceListState.status !== "loaded") return null;
  return (
    <span className="last-updated">
      Updated {formatRelativeTime(traceListState.loadedAtUnixMilliseconds, nowUnixMilliseconds)}
    </span>
  );
}

function EmptyState(
  { hasFilters, onClearFilters }: { hasFilters: boolean; onClearFilters: () => void },
) {
  if (hasFilters) {
    return (
      <div className="empty-state">
        <span className="empty-state-icon">
          <InboxIcon size={22} />
        </span>
        <h2>No traces match these filters</h2>
        <p>Correlation and Session IDs must match exactly, including case.</p>
        <button type="button" className="button button-secondary" onClick={onClearFilters}>
          Clear filters
        </button>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <InboxIcon size={22} />
      </span>
      <h2>No traces yet</h2>
      <p>
        Send OpenTelemetry spans to OTLP port <code>4318</code> (HTTP) or <code>4317</code>{" "}
        (gRPC) with your API key. Every span needs a <code>correlation.id</code> attribute.
      </p>
      <pre className="code-block">deno task send-conversation</pre>
      <p className="text-subtle">The example sends a two-step conversation to the local image.</p>
    </div>
  );
}

interface TracesKeyboardShortcutsOptions {
  traces: TraceSummary[];
  selectedTraceId: string | null;
  onSelectTrace: (traceId: string) => void;
  onCloseTrace: () => void;
  onFocusSearch: () => void;
}

/** `j`/`k` move between traces, `Escape` closes the open trace and `/` jumps to the search. */
function useTracesKeyboardShortcuts(
  { traces, selectedTraceId, onSelectTrace, onCloseTrace, onFocusSearch }:
    TracesKeyboardShortcutsOptions,
) {
  useEffect(() => {
    const handleShortcut = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.defaultPrevented || keyboardEvent.metaKey || keyboardEvent.ctrlKey) return;
      const focusedElement = document.activeElement;
      const isTyping = focusedElement instanceof HTMLInputElement ||
        focusedElement instanceof HTMLTextAreaElement;
      if (keyboardEvent.key === "Escape") {
        if (isTyping) {
          (focusedElement as HTMLElement).blur();
        } else if (selectedTraceId !== null) {
          onCloseTrace();
        }
        return;
      }
      if (isTyping) return;
      if (keyboardEvent.key === "/") {
        keyboardEvent.preventDefault();
        onFocusSearch();
        return;
      }
      if ((keyboardEvent.key === "j" || keyboardEvent.key === "k") && traces.length > 0) {
        const selectedIndex = traces.findIndex((trace) => trace.traceId === selectedTraceId);
        const nextIndex = selectedIndex === -1 ? 0 : Math.min(
          Math.max(selectedIndex + (keyboardEvent.key === "j" ? 1 : -1), 0),
          traces.length - 1,
        );
        onSelectTrace(traces[nextIndex].traceId);
      }
    };
    globalThis.addEventListener("keydown", handleShortcut);
    return () => globalThis.removeEventListener("keydown", handleShortcut);
  }, [traces, selectedTraceId, onSelectTrace, onCloseTrace, onFocusSearch]);
}
