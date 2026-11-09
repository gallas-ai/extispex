import type { LogRecord } from "@extispex/contracts";
import { type KeyboardEvent, useState } from "react";
import { Link } from "react-router";
import { AttributeSection, Property } from "../traces/span-details.tsx";
import { formatUnixNanoseconds } from "../traces/trace-formatting.ts";
import { ChevronRightIcon } from "../ui/icons.tsx";
import { formatLogBody, formatLogBodyInFull, formatLogTime } from "./log-formatting.ts";
import { SeverityBadge } from "./severity-badge.tsx";

const COLUMN_COUNT = 4;

/** A record is identified by its time and content together. */
function findRowKey(logRecord: LogRecord): string {
  return `${logRecord.timeUnixNano}.${logRecord.logId}`;
}

export function LogTable({ logs }: { logs: LogRecord[] }) {
  const [openLogIds, setOpenLogIds] = useState<ReadonlySet<string>>(new Set());

  const toggleLog = (rowKey: string) => {
    setOpenLogIds((currentKeys) => {
      const nextKeys = new Set(currentKeys);
      if (!nextKeys.delete(rowKey)) nextKeys.add(rowKey);
      return nextKeys;
    });
  };

  return (
    <div className="table-scroll">
      <table className="data-table log-table">
        <thead>
          <tr>
            <th scope="col" className="column-log-time">Time</th>
            <th scope="col" className="column-log-severity">Severity</th>
            <th scope="col" className="column-log-service">Service</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((logRecord) => (
            <LogRows
              key={findRowKey(logRecord)}
              logRecord={logRecord}
              isOpen={openLogIds.has(findRowKey(logRecord))}
              onToggle={() => toggleLog(findRowKey(logRecord))}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogRows(
  { logRecord, isOpen, onToggle }: {
    logRecord: LogRecord;
    isOpen: boolean;
    onToggle: () => void;
  },
) {
  const { date, time } = formatLogTime(logRecord.timeUnixNano);
  const toggleWithKeyboard = (keyboardEvent: KeyboardEvent<HTMLTableRowElement>) => {
    if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
      keyboardEvent.preventDefault();
      onToggle();
    }
  };
  return (
    <>
      <tr
        className={`log-row${isOpen ? " log-row-open" : ""}`}
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={onToggle}
        onKeyDown={toggleWithKeyboard}
      >
        <td
          className="column-log-time text-muted"
          title={formatUnixNanoseconds(logRecord.timeUnixNano)}
        >
          <ChevronRightIcon size={13} className="log-row-chevron" />
          <span className="log-time-date">{date}</span> {time}
        </td>
        <td className="column-log-severity">
          <SeverityBadge logRecord={logRecord} />
        </td>
        <td className="column-log-service">
          {logRecord.serviceName
            ? <span className="service-badge">{logRecord.serviceName}</span>
            : <span className="text-subtle">—</span>}
        </td>
        <td className="column-log-message">
          <code className="log-message" title={formatLogBody(logRecord.body)}>
            {formatLogBody(logRecord.body)}
          </code>
        </td>
      </tr>
      {isOpen && (
        <tr className="log-detail-row">
          <td colSpan={COLUMN_COUNT}>
            <LogDetail logRecord={logRecord} />
          </td>
        </tr>
      )}
    </>
  );
}

function LogDetail({ logRecord }: { logRecord: LogRecord }) {
  const { date, time } = formatLogTime(logRecord.timeUnixNano);
  return (
    <div className="log-detail">
      <pre className="log-detail-body">{formatLogBodyInFull(logRecord.body)}</pre>
      <dl className="property-grid">
        <Property label="Time" value={`${date} ${time}`} />
        <Property
          label="Severity"
          value={logRecord.severityText ?? logRecord.severity ?? "Not set"}
        />
        {logRecord.serviceName && <Property label="Service" value={logRecord.serviceName} />}
        {logRecord.correlationId && (
          <Property label="Correlation ID" value={logRecord.correlationId} isIdentifier />
        )}
        {logRecord.traceId && <Property label="Trace ID" value={logRecord.traceId} isIdentifier />}
        {logRecord.spanId && <Property label="Span ID" value={logRecord.spanId} isIdentifier />}
      </dl>
      {logRecord.traceId
        ? (
          <Link
            className="button button-secondary button-small log-detail-trace-link"
            to={createTraceLink(logRecord)}
          >
            Open trace
          </Link>
        )
        : <p className="text-subtle">This log record does not belong to a trace.</p>}
      <AttributeSection title="Attributes" attributes={logRecord.attributes} isInitiallyOpen />
      <AttributeSection
        title="Resource"
        attributes={logRecord.resourceAttributes}
        isInitiallyOpen={false}
      />
    </div>
  );
}

function createTraceLink(logRecord: LogRecord): string {
  const searchParameters = new URLSearchParams({ traceId: logRecord.traceId as string });
  if (logRecord.spanId) searchParameters.set("spanId", logRecord.spanId);
  return `/traces?${searchParameters}`;
}
