import { useCallback } from "react";
import type { ApiCredentials } from "../api/api-request.ts";
import { getRejectedTelemetry } from "../api/telemetry-api.ts";
import { AlertIcon } from "../ui/icons.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";

const RECORD_WORDS = {
  spans: ["span", "spans"],
  logs: ["log record", "log records"],
  metrics: ["metric data point", "metric data points"],
} as const;

interface RejectedTelemetryNoticeProps {
  credentials: ApiCredentials;
  signal: keyof typeof RECORD_WORDS;
}

/** Says when ingestion recently rejected records, which an exporter otherwise reports to no one. */
export function RejectedTelemetryNotice({ credentials, signal }: RejectedTelemetryNoticeProps) {
  const loadRejectedTelemetry = useCallback(() => getRejectedTelemetry(credentials), [credentials]);
  const [resourceState] = useApiResource(loadRejectedTelemetry);
  // The notice is an extra: when it cannot be loaded, the page itself is what matters.
  if (resourceState.status !== "loaded") return null;
  const { windowHours, [signal]: summary } = resourceState.resource;
  if (summary.rejectedCount === 0) return null;
  const [singular, plural] = RECORD_WORDS[signal];
  return (
    <div className="callout callout-warning rejected-telemetry-notice" role="status">
      <AlertIcon size={16} />
      <div>
        <p className="rejected-telemetry-count">
          {summary.rejectedCount.toLocaleString()} {summary.rejectedCount === 1 ? singular : plural}
          {" "}
          rejected in the last {windowHours} hours
        </p>
        {summary.lastReason !== null && (
          <p className="rejected-telemetry-reason">Latest: {summary.lastReason}</p>
        )}
      </div>
    </div>
  );
}
