import type { LogRecord } from "@extispex/contracts";

/** The log's severity; the application's own word for it is available as a tooltip. */
export function SeverityBadge({ logRecord }: { logRecord: LogRecord }) {
  const severity = logRecord.severity ?? "unspecified";
  return (
    <span
      className={`severity-badge severity-${severity}`}
      title={logRecord.severityText ?? undefined}
    >
      {logRecord.severity ?? "—"}
    </span>
  );
}
