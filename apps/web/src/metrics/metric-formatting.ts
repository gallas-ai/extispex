import type { MetricAggregation, MetricResultSeries } from "@extispex/contracts";

const valueFormat = new Intl.NumberFormat("en", { maximumSignificantDigits: 3 });

/**
 * OpenTelemetry writes units in UCUM: `1` means a plain count and `{request}` is an annotation
 * that names what is counted.
 */
export function describeUnit(unit: string, aggregation: MetricAggregation): string {
  const readableUnit = unit === "1" ? "" : unit.replace(/^\{(.*)\}$/, "$1");
  if (aggregation !== "rate") return readableUnit;
  return readableUnit === "" ? "/s" : `${readableUnit}/s`;
}

export function formatMetricValue(value: number | null, unitLabel: string): string {
  if (value === null) return "–";
  const formattedValue = valueFormat.format(value);
  if (unitLabel === "") return formattedValue;
  return unitLabel.startsWith("/")
    ? `${formattedValue}${unitLabel}`
    : `${formattedValue} ${unitLabel}`;
}

/**
 * A group's attribute values, such as `small · eu`, or the metric's name for a result that is not
 * grouped. The keys go into the table's heading once, so the labels stay short enough for a legend.
 */
export function labelSeries(series: MetricResultSeries, metricName: string): string {
  const groupValues = Object.values(series.group);
  if (groupValues.length === 0) return metricName;
  return groupValues.map((value) => value ?? "(none)").join(GROUP_VALUE_SEPARATOR);
}

export function labelGroupColumn(groupByKeys: string[]): string {
  return groupByKeys.length === 0 ? "Series" : groupByKeys.join(GROUP_VALUE_SEPARATOR);
}

const GROUP_VALUE_SEPARATOR = " · ";

export interface SeriesStatistics {
  latest: number | null;
  average: number | null;
  peak: number | null;
}

export function summarizeValues(values: (number | null)[]): SeriesStatistics {
  const presentValues = values.filter((value): value is number => value !== null);
  if (presentValues.length === 0) return { latest: null, average: null, peak: null };
  return {
    latest: presentValues[presentValues.length - 1],
    average: presentValues.reduce((total, value) => total + value, 0) / presentValues.length,
    peak: Math.max(...presentValues),
  };
}
