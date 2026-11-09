import type { LogRecord } from "@extispex/contracts";
import { useCallback, useMemo, useState } from "react";
import type { ApiCredentials } from "../api/api-request.ts";
import { listLogs } from "../api/telemetry-api.ts";
import {
  type LogsUrlState,
  resolveLogTimeBounds,
  serializeLogsUrlState,
  useLogsUrlState,
} from "../navigation/logs-url-state.ts";
import { InboxIcon, RefreshIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { type ResourcePage, usePagedResource } from "../ui/use-paged-resource.ts";
import { LogFilterBar } from "./log-filters.tsx";
import { LogTable } from "./log-table.tsx";
import { RejectedTelemetryNotice } from "./rejected-telemetry-notice.tsx";

interface LogsPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function LogsPage({ credentials, onSignInRequired }: LogsPageProps) {
  const [appliedFilters, applyFilters] = useLogsUrlState();
  const [refreshCount, setRefreshCount] = useState(0);

  return (
    <div className="page logs-page">
      <div className="page-header">
        <div className="page-heading">
          <h1>Logs</h1>
          <p className="page-subtitle">Newest first</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setRefreshCount(refreshCount + 1)}
          >
            <RefreshIcon size={14} />
            Refresh
          </button>
        </div>
      </div>
      <LogFilterBar appliedFilters={appliedFilters} onApplyFilters={applyFilters} />
      <RejectedTelemetryNotice credentials={credentials} signal="logs" />
      {/* Keyed by the filters, so that a new search starts from its first page. */}
      <LogResults
        key={serializeLogsUrlState(appliedFilters)}
        credentials={credentials}
        filters={appliedFilters}
        refreshKey={String(refreshCount)}
        onClearFilters={() => applyFilters(removeRecordFilters(appliedFilters))}
        onSignInRequired={onSignInRequired}
      />
    </div>
  );
}

/** Keeps the time range, which the empty state's advice treats separately. */
function removeRecordFilters(currentFilters: LogsUrlState): LogsUrlState {
  return {
    ...currentFilters,
    search: "",
    minimumSeverity: "",
    serviceName: "",
    correlationId: "",
    traceId: "",
    attribute: "",
  };
}

interface LogResultsProps {
  credentials: ApiCredentials;
  filters: LogsUrlState;
  refreshKey: string;
  onClearFilters: () => void;
  onSignInRequired: () => void;
}

function LogResults(
  { credentials, filters, refreshKey, onClearFilters, onSignInRequired }: LogResultsProps,
) {
  const loadPage = useCallback(
    async (cursor: string | null): Promise<ResourcePage<LogRecord, string>> => {
      const { logs, nextCursor } = await listLogs(credentials, {
        ...resolveLogTimeBounds(filters, Date.now()),
        search: filters.search,
        minimumSeverity: filters.minimumSeverity || undefined,
        serviceName: filters.serviceName,
        correlationId: filters.correlationId,
        traceId: filters.traceId,
        attribute: filters.attribute,
        cursor: cursor ?? undefined,
      });
      return { items: logs, nextCursor };
    },
    [credentials, filters],
  );
  const { state, loadMore, retry } = usePagedResource(loadPage, refreshKey);
  const hasRecordFilters = useMemo(
    () =>
      [
        filters.search,
        filters.minimumSeverity,
        filters.serviceName,
        filters.correlationId,
        filters.traceId,
        filters.attribute,
      ].some((filterValue) => filterValue !== ""),
    [filters],
  );

  return (
    <section className="panel log-list-panel" aria-label="Log records">
      {state.status === "loading" && <div className="panel-loading" aria-busy="true" />}
      {state.status === "failed" && (
        <LoadError
          subject="Logs"
          message={state.message}
          isSignInRequired={state.isSignInRequired}
          onRetry={retry}
          onSignInRequired={onSignInRequired}
        />
      )}
      {state.status === "loaded" && state.items.length === 0 && (
        <EmptyLogs hasFilters={hasRecordFilters} onClearFilters={onClearFilters} />
      )}
      {state.status === "loaded" && state.items.length > 0 && (
        <>
          <LogTable logs={state.items} />
          {state.hasMore && (
            <div className="table-footer log-table-footer">
              <button
                type="button"
                className="button button-secondary"
                disabled={state.isLoadingMore}
                onClick={loadMore}
              >
                {state.isLoadingMore ? "Loading…" : "Load older records"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EmptyLogs(
  { hasFilters, onClearFilters }: { hasFilters: boolean; onClearFilters: () => void },
) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <InboxIcon size={22} />
      </span>
      {hasFilters
        ? (
          <>
            <h2>No log records match these filters</h2>
            <p>The search finds whole words in the message. A wider time range may help.</p>
            <button type="button" className="button button-secondary" onClick={onClearFilters}>
              Clear filters
            </button>
          </>
        )
        : (
          <>
            <h2>No log records in this time range</h2>
            <p>
              Send OpenTelemetry logs to OTLP port <code>4318</code> (HTTP) or <code>4317</code>
              {" "}
              (gRPC) with your API key. A log with a <code>trace_id</code> needs a{" "}
              <code>correlation.id</code> attribute.
            </p>
          </>
        )}
    </div>
  );
}
