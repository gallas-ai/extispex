import type { LogRecord } from "@extispex/contracts";
import { useCallback } from "react";
import { Link } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import { listLogs } from "../api/telemetry-api.ts";
import { formatDuration, millisecondsBetween } from "../traces/trace-formatting.ts";
import { useApiResource } from "../ui/use-api-resource.ts";
import { formatLogBody } from "./log-formatting.ts";
import { SeverityBadge } from "./severity-badge.tsx";

/** Enough for almost every trace; the Logs page pages through the rest. */
const MAXIMUM_LOGS_IN_A_TRACE_VIEW = 200;

interface TraceLogsProps {
  credentials: ApiCredentials;
  traceId: string;
  traceStartUnixNanoseconds: string;
  onSelectSpan: (spanId: string) => void;
}

/** The trace's log records in the order they happened, each leading to its span. */
export function TraceLogs(
  { credentials, traceId, traceStartUnixNanoseconds, onSelectSpan }: TraceLogsProps,
) {
  const loadLogs = useCallback(
    () => listLogs(credentials, { traceId, limit: MAXIMUM_LOGS_IN_A_TRACE_VIEW }),
    [credentials, traceId],
  );
  const [resourceState] = useApiResource(loadLogs);
  const logsPageLink = `/logs?${new URLSearchParams({ traceId, range: "30d" })}`;

  return (
    <section className="trace-logs" aria-label="Logs of this trace">
      <header className="trace-logs-header">
        <h3>
          Logs{resourceState.status === "loaded" ? ` (${resourceState.resource.logs.length})` : ""}
        </h3>
        {resourceState.status === "loaded" && resourceState.resource.logs.length > 0 && (
          <Link className="text-link" to={logsPageLink}>Open in Logs</Link>
        )}
      </header>
      {resourceState.status === "loading" && <span className="skeleton skeleton-text-wide" />}
      {resourceState.status === "failed" && (
        <p className="text-muted" role="alert">{resourceState.message}</p>
      )}
      {resourceState.status === "loaded" && resourceState.resource.logs.length === 0 && (
        <p className="text-subtle">No log records belong to this trace.</p>
      )}
      {resourceState.status === "loaded" && resourceState.resource.logs.length > 0 && (
        <ol className="trace-log-list">
          {[...resourceState.resource.logs].reverse().map((logRecord) => (
            <TraceLogRow
              key={`${logRecord.timeUnixNano}.${logRecord.logId}`}
              logRecord={logRecord}
              traceStartUnixNanoseconds={traceStartUnixNanoseconds}
              onSelectSpan={onSelectSpan}
            />
          ))}
        </ol>
      )}
      {resourceState.status === "loaded" && resourceState.resource.nextCursor !== null && (
        <p className="text-subtle">
          Showing the latest {MAXIMUM_LOGS_IN_A_TRACE_VIEW}.{" "}
          <Link className="text-link" to={logsPageLink}>See all</Link>
        </p>
      )}
    </section>
  );
}

function TraceLogRow(
  { logRecord, traceStartUnixNanoseconds, onSelectSpan }: {
    logRecord: LogRecord;
    traceStartUnixNanoseconds: string;
    onSelectSpan: (spanId: string) => void;
  },
) {
  const offsetMilliseconds = millisecondsBetween(
    traceStartUnixNanoseconds,
    logRecord.timeUnixNano,
  );
  const content = (
    <>
      <span className="trace-log-offset">
        {offsetMilliseconds < 0 ? "-" : "+"}
        {formatDuration(Math.abs(offsetMilliseconds))}
      </span>
      <SeverityBadge logRecord={logRecord} />
      <code className="trace-log-message">{formatLogBody(logRecord.body)}</code>
    </>
  );
  return (
    <li className="trace-log-row">
      {logRecord.spanId === null ? <div className="trace-log-content">{content}</div> : (
        <button
          type="button"
          className="trace-log-content trace-log-button"
          title="Show this record's span"
          onClick={() => onSelectSpan(logRecord.spanId as string)}
        >
          {content}
        </button>
      )}
    </li>
  );
}
