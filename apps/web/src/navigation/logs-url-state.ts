import type { LogSeverity } from "@extispex/contracts";
import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";

const MINUTE_MILLISECONDS = 60_000;
const HOUR_MILLISECONDS = 60 * MINUTE_MILLISECONDS;
const DAY_MILLISECONDS = 24 * HOUR_MILLISECONDS;

export const LOG_TIME_RANGE_PRESETS = [
  { value: "15m", label: "Last 15 minutes", milliseconds: 15 * MINUTE_MILLISECONDS },
  { value: "1h", label: "Last hour", milliseconds: HOUR_MILLISECONDS },
  { value: "6h", label: "Last 6 hours", milliseconds: 6 * HOUR_MILLISECONDS },
  { value: "24h", label: "Last 24 hours", milliseconds: DAY_MILLISECONDS },
  { value: "7d", label: "Last 7 days", milliseconds: 7 * DAY_MILLISECONDS },
  { value: "30d", label: "Last 30 days", milliseconds: 30 * DAY_MILLISECONDS },
] as const;

/** Lowest first. The web app imports only types from the contracts, so it lists them itself. */
export const LOG_SEVERITIES: LogSeverity[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export const CUSTOM_LOG_TIME_RANGE = "custom";
export const DEFAULT_LOG_TIME_RANGE = "24h";

/** What the Logs page shows, kept in the query string so that a search can be shared as a link. */
export interface LogsUrlState {
  search: string;
  minimumSeverity: LogSeverity | "";
  serviceName: string;
  correlationId: string;
  traceId: string;
  /** One attribute filter, written `key=value`. */
  attribute: string;
  /** A preset's value, or `custom` to use `from` and `to`. */
  range: string;
  from: string;
  to: string;
}

const TEXT_FIELDS = [
  "search",
  "serviceName",
  "correlationId",
  "traceId",
  "attribute",
  "from",
  "to",
] as const;

export function parseLogsUrlState(search: string): LogsUrlState {
  const searchParameters = new URLSearchParams(search);
  const readText = (parameter: string) => searchParameters.get(parameter) ?? "";
  const severity = LOG_SEVERITIES.find((candidate) =>
    candidate === searchParameters.get("minimumSeverity")
  );
  const range = readText("range");
  const isKnownRange = range === CUSTOM_LOG_TIME_RANGE ||
    LOG_TIME_RANGE_PRESETS.some((preset) => preset.value === range);
  return {
    search: readText("search"),
    minimumSeverity: severity ?? "",
    serviceName: readText("serviceName"),
    correlationId: readText("correlationId"),
    traceId: readText("traceId"),
    attribute: readText("attribute"),
    range: isKnownRange ? range : DEFAULT_LOG_TIME_RANGE,
    from: readText("from"),
    to: readText("to"),
  };
}

export function serializeLogsUrlState(urlState: LogsUrlState): string {
  const searchParameters = new URLSearchParams();
  for (const field of TEXT_FIELDS) {
    if (urlState[field]) searchParameters.set(field, urlState[field]);
  }
  if (urlState.minimumSeverity) {
    searchParameters.set("minimumSeverity", urlState.minimumSeverity);
  }
  if (urlState.range !== DEFAULT_LOG_TIME_RANGE) searchParameters.set("range", urlState.range);
  const serialized = searchParameters.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

/** The time bounds to ask the API for, with a preset counted back from `nowUnixMilliseconds`. */
export function resolveLogTimeBounds(
  urlState: Pick<LogsUrlState, "range" | "from" | "to">,
  nowUnixMilliseconds: number,
): { from?: string; to?: string } {
  if (urlState.range === CUSTOM_LOG_TIME_RANGE) {
    return { from: urlState.from || undefined, to: urlState.to || undefined };
  }
  const preset = LOG_TIME_RANGE_PRESETS.find(({ value }) => value === urlState.range);
  return preset === undefined
    ? {}
    : { from: new Date(nowUnixMilliseconds - preset.milliseconds).toISOString() };
}

export function useLogsUrlState(): [LogsUrlState, (nextState: LogsUrlState) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const urlState = useMemo(() => parseLogsUrlState(location.search), [location.search]);
  const updateUrlState = useCallback(
    (nextState: LogsUrlState) => {
      navigate({ pathname: "/logs", search: serializeLogsUrlState(nextState) });
    },
    [navigate],
  );
  return [urlState, updateUrlState];
}
