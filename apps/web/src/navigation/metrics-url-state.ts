import type { MetricAggregation } from "@extispex/contracts";
import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { LOG_TIME_RANGE_PRESETS } from "./logs-url-state.ts";

/** The same presets as the Logs page, so that both read a time range the same way. */
export const METRIC_TIME_RANGE_PRESETS = LOG_TIME_RANGE_PRESETS;
export const DEFAULT_METRIC_TIME_RANGE = "1h";

/** Lists them in the web app, which imports only types from the contracts. */
const METRIC_AGGREGATIONS: MetricAggregation[] = ["sum", "avg", "rate", "p95"];

/** The aggregation a metric opens with: the one that best answers "how is it doing?". */
const PREFERRED_AGGREGATIONS: MetricAggregation[] = ["p95", "rate", "avg", "sum"];

/** What the Metrics page shows, kept in the query string so that a chart can be shared as a link. */
export interface MetricsUrlState {
  metric: string;
  aggregation: MetricAggregation | "";
  groupBy: string;
  /** One attribute filter, written `key=value`. */
  attribute: string;
  range: string;
}

export function parseMetricsUrlState(search: string): MetricsUrlState {
  const searchParameters = new URLSearchParams(search);
  const readText = (parameter: string) => searchParameters.get(parameter) ?? "";
  const aggregation = METRIC_AGGREGATIONS.find((candidate) =>
    candidate === searchParameters.get("aggregation")
  );
  const range = readText("range");
  return {
    metric: readText("metric"),
    aggregation: aggregation ?? "",
    groupBy: readText("groupBy"),
    attribute: readText("attribute"),
    range: METRIC_TIME_RANGE_PRESETS.some((preset) => preset.value === range)
      ? range
      : DEFAULT_METRIC_TIME_RANGE,
  };
}

export function serializeMetricsUrlState(urlState: MetricsUrlState): string {
  const searchParameters = new URLSearchParams();
  for (const field of ["metric", "aggregation", "groupBy", "attribute"] as const) {
    if (urlState[field]) searchParameters.set(field, urlState[field]);
  }
  if (urlState.range !== DEFAULT_METRIC_TIME_RANGE) searchParameters.set("range", urlState.range);
  const serialized = searchParameters.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

/** The chosen aggregation when the metric supports it, or else the metric's best one. */
export function chooseAggregation(
  requestedAggregation: MetricAggregation | "",
  supportedAggregations: MetricAggregation[],
): MetricAggregation {
  if (requestedAggregation !== "" && supportedAggregations.includes(requestedAggregation)) {
    return requestedAggregation;
  }
  return PREFERRED_AGGREGATIONS.find((aggregation) =>
    supportedAggregations.includes(aggregation)
  ) ?? supportedAggregations[0];
}

export function resolveMetricTimeBounds(
  range: string,
  nowUnixMilliseconds: number,
): { from: string; to: string } {
  const preset = METRIC_TIME_RANGE_PRESETS.find(({ value }) => value === range) ??
    METRIC_TIME_RANGE_PRESETS[1];
  return {
    from: new Date(nowUnixMilliseconds - preset.milliseconds).toISOString(),
    to: new Date(nowUnixMilliseconds).toISOString(),
  };
}

export function useMetricsUrlState(): [MetricsUrlState, (nextState: MetricsUrlState) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const urlState = useMemo(() => parseMetricsUrlState(location.search), [location.search]);
  const updateUrlState = useCallback(
    (nextState: MetricsUrlState) => {
      navigate({ pathname: "/metrics", search: serializeMetricsUrlState(nextState) });
    },
    [navigate],
  );
  return [urlState, updateUrlState];
}
