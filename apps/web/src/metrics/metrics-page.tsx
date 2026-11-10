import type {
  MetricAggregation,
  MetricAttribute,
  MetricSummary,
  QueryMetricResponse,
} from "@extispex/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ApiCredentials } from "../api/api-request.ts";
import { listMetricAttributes, listMetrics, queryMetric } from "../api/telemetry-api.ts";
import { RejectedTelemetryNotice } from "../logs/rejected-telemetry-notice.tsx";
import {
  chooseAggregation,
  METRIC_TIME_RANGE_PRESETS,
  type MetricsUrlState,
  resolveMetricTimeBounds,
  serializeMetricsUrlState,
  useMetricsUrlState,
} from "../navigation/metrics-url-state.ts";
import { FilterField } from "../traces/trace-filters.tsx";
import { ChartIcon, RefreshIcon, TagIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { type ChartSeries, formatChartTime, MetricChart } from "./metric-chart.tsx";
import {
  describeUnit,
  formatMetricValue,
  labelGroupColumn,
  labelSeries,
  summarizeValues,
} from "./metric-formatting.ts";
import { useStableColorSlots } from "./stable-color-slots.ts";
import { CHART_SERIES_SLOT_COUNT, useChartTheme } from "./use-chart-theme.ts";

interface MetricsPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

const AGGREGATION_LABELS: Record<MetricAggregation, string> = {
  sum: "Sum",
  avg: "Average",
  rate: "Rate per second",
  p95: "95th percentile",
};

export function MetricsPage({ credentials, onSignInRequired }: MetricsPageProps) {
  const [urlState, applyUrlState] = useMetricsUrlState();
  const [refreshCount, setRefreshCount] = useState(0);
  const loadMetrics = useCallback(() => listMetrics(credentials), [credentials]);
  const [metricsState, reloadMetrics] = useApiResource(loadMetrics);

  const refresh = () => {
    reloadMetrics();
    setRefreshCount(refreshCount + 1);
  };

  return (
    <div className="page metrics-page">
      <div className="page-header">
        <div className="page-heading">
          <h1>Metrics</h1>
          <p className="page-subtitle">One metric over time, aggregated and grouped</p>
        </div>
        <div className="page-actions">
          <button type="button" className="button button-secondary" onClick={refresh}>
            <RefreshIcon size={14} />
            Refresh
          </button>
        </div>
      </div>
      {metricsState.status === "loading" && (
        <section className="panel">
          <div className="panel-loading" aria-busy="true" />
        </section>
      )}
      {metricsState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="Metrics"
            message={metricsState.message}
            isSignInRequired={metricsState.isSignInRequired}
            onRetry={reloadMetrics}
            onSignInRequired={onSignInRequired}
          />
        </section>
      )}
      {metricsState.status === "loaded" && (
        <LoadedMetrics
          credentials={credentials}
          metrics={metricsState.resource.metrics}
          urlState={urlState}
          onChange={applyUrlState}
          refreshKey={String(refreshCount)}
          onSignInRequired={onSignInRequired}
        />
      )}
    </div>
  );
}

interface LoadedMetricsProps {
  credentials: ApiCredentials;
  metrics: MetricSummary[];
  urlState: MetricsUrlState;
  onChange: (nextState: MetricsUrlState) => void;
  refreshKey: string;
  onSignInRequired: () => void;
}

function LoadedMetrics(
  { credentials, metrics, urlState, onChange, refreshKey, onSignInRequired }: LoadedMetricsProps,
) {
  if (metrics.length === 0) {
    return (
      <>
        <RejectedTelemetryNotice credentials={credentials} signal="metrics" />
        <section className="panel">
          <div className="empty-state">
            <span className="empty-state-icon">
              <ChartIcon size={22} />
            </span>
            <h2>No metrics yet</h2>
            <p>
              Send OpenTelemetry metrics to OTLP port <code>4318</code> (HTTP, path{" "}
              <code>/v1/metrics</code>) or <code>4317</code>{" "}
              (gRPC) with your API key. Sums, gauges and histograms are accepted.
            </p>
          </div>
        </section>
      </>
    );
  }
  // The first metric opens when none is chosen, so the page never starts empty.
  const metricName = urlState.metric || metrics[0].name;
  const metric = metrics.find((candidate) => candidate.name === metricName) ?? null;
  const aggregation = metric === null
    ? null
    : chooseAggregation(urlState.aggregation, metric.supportedAggregations);
  const shownState: MetricsUrlState = {
    ...urlState,
    metric: metricName,
    aggregation: aggregation ?? "",
  };

  return (
    <>
      <MetricQueryBuilder
        credentials={credentials}
        metrics={metrics}
        metric={metric}
        shownState={shownState}
        onChange={onChange}
      />
      <RejectedTelemetryNotice credentials={credentials} signal="metrics" />
      {metric === null || aggregation === null
        ? (
          <section className="panel">
            <div className="empty-state">
              <span className="empty-state-icon">
                <ChartIcon size={22} />
              </span>
              <h2>The metric {metricName} does not exist</h2>
              <p>It may not have been sent to this Project. Choose another metric above.</p>
            </div>
          </section>
        )
        : (
          <MetricResult
            key={`${serializeMetricsUrlState(shownState)}#${refreshKey}`}
            credentials={credentials}
            metric={metric}
            aggregation={aggregation}
            urlState={shownState}
            onSignInRequired={onSignInRequired}
          />
        )}
    </>
  );
}

interface MetricQueryBuilderProps {
  credentials: ApiCredentials;
  metrics: MetricSummary[];
  metric: MetricSummary | null;
  shownState: MetricsUrlState;
  onChange: (nextState: MetricsUrlState) => void;
}

/** Lists change the chart at once; the attribute filter applies when the form is sent. */
function MetricQueryBuilder(
  { credentials, metrics, metric, shownState, onChange }: MetricQueryBuilderProps,
) {
  const [draftAttribute, setDraftAttribute] = useState(shownState.attribute);
  useEffect(() => {
    setDraftAttribute(shownState.attribute);
  }, [shownState.attribute]);

  const metricNames = useMemo(
    () => [...new Set(metrics.map((candidate) => candidate.name))],
    [metrics],
  );
  const loadAttributes = useCallback(
    () => listMetricAttributes(credentials, shownState.metric),
    [credentials, shownState.metric],
  );
  const [attributesState] = useApiResource(loadAttributes);
  const attributes = attributesState.status === "loaded" ? attributesState.resource.attributes : [];

  const applyAttribute = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    onChange({ ...shownState, attribute: draftAttribute.trim() });
  };

  return (
    <form className="filter-bar metric-query-builder" onSubmit={applyAttribute}>
      <div className="metric-builder-field metric-builder-metric">
        <label className="metric-builder-label" htmlFor="metric-builder-metric-select">
          Metric
        </label>
        <select
          id="metric-builder-metric-select"
          className="select-input"
          value={shownState.metric}
          onChange={(changeEvent) =>
            // Another metric may not have the same aggregation or attributes.
            onChange({
              ...shownState,
              metric: changeEvent.target.value,
              aggregation: "",
              groupBy: "",
              attribute: "",
            })}
        >
          {!metricNames.includes(shownState.metric) && (
            <option value={shownState.metric}>{shownState.metric}</option>
          )}
          {metricNames.map((metricName) => (
            <option key={metricName} value={metricName}>{metricName}</option>
          ))}
        </select>
      </div>
      <div className="metric-builder-field">
        <label className="metric-builder-label" htmlFor="metric-builder-aggregation">
          Aggregation
        </label>
        <select
          id="metric-builder-aggregation"
          className="select-input"
          value={shownState.aggregation}
          disabled={metric === null}
          onChange={(changeEvent) =>
            onChange({
              ...shownState,
              aggregation: changeEvent.target.value as MetricAggregation,
            })}
        >
          {(metric?.supportedAggregations ?? []).map((aggregation) => (
            <option key={aggregation} value={aggregation}>{AGGREGATION_LABELS[aggregation]}</option>
          ))}
        </select>
      </div>
      <div className="metric-builder-field">
        <label className="metric-builder-label" htmlFor="metric-builder-group-by">Group by</label>
        <select
          id="metric-builder-group-by"
          className="select-input"
          value={shownState.groupBy}
          onChange={(changeEvent) => onChange({ ...shownState, groupBy: changeEvent.target.value })}
        >
          <option value="">No grouping</option>
          <GroupByOptions
            attributes={attributes}
            source="metric"
            label="Attributes"
            selectedKey={shownState.groupBy}
          />
          <GroupByOptions
            attributes={attributes}
            source="resource"
            label="Resource"
            selectedKey={shownState.groupBy}
          />
        </select>
      </div>
      <div className="metric-builder-field">
        <label className="metric-builder-label" htmlFor="metric-builder-range">Time range</label>
        <select
          id="metric-builder-range"
          className="select-input"
          value={shownState.range}
          onChange={(changeEvent) => onChange({ ...shownState, range: changeEvent.target.value })}
        >
          {METRIC_TIME_RANGE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label}</option>
          ))}
        </select>
      </div>
      <FilterField
        id="metric-attribute"
        label="Attribute: key=value"
        icon={<TagIcon size={14} />}
        value={draftAttribute}
        isApplied={shownState.attribute !== ""}
        pattern="[^=]+=.*"
        patternHint="Write the attribute as key=value."
        onChange={setDraftAttribute}
        onClear={() => {
          setDraftAttribute("");
          onChange({ ...shownState, attribute: "" });
        }}
      />
      <button type="submit" className="button button-primary">Apply filter</button>
    </form>
  );
}

function GroupByOptions(
  { attributes, source, label, selectedKey }: {
    attributes: MetricAttribute[];
    source: MetricAttribute["source"];
    label: string;
    selectedKey: string;
  },
) {
  const sourceAttributes = attributes.filter((attribute) => attribute.source === source);
  // A link may group by a key that this list has not loaded yet.
  const isSelectedKeyMissing = source === "metric" && selectedKey !== "" &&
    !attributes.some((attribute) => attribute.key === selectedKey);
  if (sourceAttributes.length === 0 && !isSelectedKeyMissing) return null;
  return (
    <optgroup label={label}>
      {isSelectedKeyMissing && <option value={selectedKey}>{selectedKey}</option>}
      {sourceAttributes.map((attribute) => (
        <option key={attribute.key} value={attribute.key}>{attribute.key}</option>
      ))}
    </optgroup>
  );
}

interface MetricResultProps {
  credentials: ApiCredentials;
  metric: MetricSummary;
  aggregation: MetricAggregation;
  urlState: MetricsUrlState;
  onSignInRequired: () => void;
}

function MetricResult(
  { credentials, metric, aggregation, urlState, onSignInRequired }: MetricResultProps,
) {
  const loadResult = useCallback(
    () =>
      queryMetric(credentials, {
        metric: metric.name,
        aggregation,
        ...resolveMetricTimeBounds(urlState.range, Date.now()),
        groupBy: urlState.groupBy,
        attribute: urlState.attribute,
      }),
    [credentials, metric.name, aggregation, urlState.range, urlState.groupBy, urlState.attribute],
  );
  const [resultState, retry] = useApiResource(loadResult);

  return (
    <section className="panel metric-result-panel" aria-label="Metric chart">
      {resultState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
      {resultState.status === "failed" && (
        <LoadError
          subject="The chart"
          message={resultState.message}
          isSignInRequired={resultState.isSignInRequired}
          onRetry={retry}
          onSignInRequired={onSignInRequired}
        />
      )}
      {resultState.status === "loaded" && (
        <MetricResultView
          result={resultState.resource}
          metric={metric}
          aggregation={aggregation}
          resetKey={`${metric.name}#${urlState.groupBy}`}
          groupByKeys={urlState.groupBy === "" ? [] : [urlState.groupBy]}
        />
      )}
    </section>
  );
}

function MetricResultView(
  { result, metric, aggregation, resetKey, groupByKeys }: {
    result: QueryMetricResponse;
    metric: MetricSummary;
    aggregation: MetricAggregation;
    resetKey: string;
    groupByKeys: string[];
  },
) {
  const theme = useChartTheme();
  const unitLabel = describeUnit(metric.unit, aggregation);
  const rows = useMemo(
    () =>
      result.series.map((series) => {
        const presentValues = series.values.filter((value): value is number => value !== null);
        return {
          label: labelSeries(series, metric.name),
          values: series.values,
          statistics: summarizeValues(series.values),
          weight: presentValues.reduce((total, value) => total + Math.abs(value), 0),
        };
      }),
    [result, metric.name],
  );
  // At most eight lines: more colors could not be told apart. The table lists every group.
  const chartedLabels = useMemo(
    () =>
      [...rows].sort((firstRow, secondRow) => secondRow.weight - firstRow.weight)
        .slice(0, CHART_SERIES_SLOT_COUNT)
        .map((row) => row.label),
    [rows],
  );
  const colorSlots = useStableColorSlots(chartedLabels, resetKey, CHART_SERIES_SLOT_COUNT);
  const chartSeries: ChartSeries[] = useMemo(
    () =>
      rows.filter((row) => colorSlots.has(row.label)).map((row) => ({
        label: row.label,
        colorSlot: colorSlots.get(row.label)!,
        values: row.values,
      })),
    [rows, colorSlots],
  );
  const hasData = rows.some((row) => row.statistics.latest !== null);
  const title = `${AGGREGATION_LABELS[aggregation]} of ${metric.name}`;

  if (!hasData) {
    return (
      <div className="empty-state">
        <span className="empty-state-icon">
          <ChartIcon size={22} />
        </span>
        <h2>No data in this time range</h2>
        <p>
          {metric.name} has no points here that match the filters. A wider time range may help.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="metric-result-header">
        <h2 className="metric-result-title">{title}</h2>
        <span className="metric-result-meta">
          {unitLabel !== "" && <>{unitLabel} ·{" "}</>}
          {result.stepSeconds >= 60 ? `${result.stepSeconds / 60} min` : `${result.stepSeconds} s`}
          {" "}
          steps · {formatChartTime(result.times[0])} to{" "}
          {formatChartTime(result.times[result.times.length - 1])}
        </span>
      </div>
      {rows.length > chartSeries.length && (
        <p className="metric-chart-note">
          The chart shows the {chartSeries.length} largest of {rows.length}{" "}
          groups. The table lists them all.
        </p>
      )}
      <MetricChart
        result={result}
        series={chartSeries}
        unitLabel={unitLabel}
        theme={theme}
        description={`${title}, ${chartSeries.length} ${
          chartSeries.length === 1 ? "line" : "lines"
        }. The table below lists the values.`}
      />
      <div className="table-scroll">
        <table className="data-table metric-series-table">
          <thead>
            <tr>
              <th scope="col">{labelGroupColumn(groupByKeys)}</th>
              <th scope="col" className="column-numeric">Latest</th>
              <th scope="col" className="column-numeric metric-secondary-column">Average</th>
              <th scope="col" className="column-numeric metric-secondary-column">Peak</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const colorSlot = colorSlots.get(row.label);
              return (
                <tr key={row.label}>
                  <td className="metric-series-label">
                    <span
                      className="metric-series-swatch"
                      style={colorSlot === undefined
                        ? undefined
                        : { background: theme.seriesColors[colorSlot] }}
                      aria-hidden="true"
                    />
                    <span className="metric-series-name">{row.label}</span>
                  </td>
                  <td className="column-numeric">
                    {formatMetricValue(row.statistics.latest, unitLabel)}
                  </td>
                  <td className="column-numeric metric-secondary-column">
                    {formatMetricValue(row.statistics.average, unitLabel)}
                  </td>
                  <td className="column-numeric metric-secondary-column">
                    {formatMetricValue(row.statistics.peak, unitLabel)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
