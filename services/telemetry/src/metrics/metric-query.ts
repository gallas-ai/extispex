import {
  type ListMetricAttributesResponse,
  type MetricAggregation,
  type MetricAttribute,
  type MetricSummary,
  parseAttributeFilters,
  type QueryMetricQuery,
  type QueryMetricResponse,
} from "@extispex/contracts";
import type {
  MetricReadRange,
  MetricRepository,
  StoredHistogramCounts,
  StoredHistogramPoint,
  StoredMetricSeries,
} from "../storage/metric-repository.ts";
import { formatUnixNanosecondsForStorage } from "../storage/span-record-entity.ts";
import { estimateHistogramQuantile } from "./histogram-quantile.ts";

/** A request that cannot be answered as it stands; the message says how to change it. */
export class MetricQueryError extends Error {
  override name = "MetricQueryError";
  constructor(readonly errorCode: string, message: string) {
    super(message);
  }
}

export interface MetricQueries {
  listMetrics(projectId: string): Promise<MetricSummary[]>;
  listMetricAttributes(
    projectId: string,
    metricName: string,
  ): Promise<ListMetricAttributesResponse>;
  queryMetric(projectId: string, query: QueryMetricQuery): Promise<QueryMetricResponse>;
}

/** What a metric's numbers are, which decides how they can be added up. */
type ValueKind = "increment" | "level" | "distribution";

const SUPPORTED_AGGREGATIONS: Record<ValueKind, MetricAggregation[]> = {
  increment: ["sum", "avg", "rate"],
  level: ["sum", "avg"],
  distribution: ["sum", "avg", "rate", "p95"],
};

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_HOUR = 3_600_000;
const P95_QUANTILE = 0.95;

/** Steps a chart is cut into when the query does not choose. OTel SDKs export every 60 seconds. */
const AUTOMATIC_STEP_SECONDS = [
  60,
  120,
  300,
  600,
  900,
  1_800,
  3_600,
  7_200,
  10_800,
  21_600,
  43_200,
  86_400,
];
const TARGET_AUTOMATIC_STEP_COUNT = 240;
const MAXIMUM_STEP_COUNT = 1_000;
const MAXIMUM_METRIC_DEFINITIONS = 5_000;
/** Filters run on the Time Series after reading them, so more are read than may be charted. */
const MAXIMUM_SERIES_SCANNED = 20_000;
const MAXIMUM_SERIES_CHARTED = 2_000;
const MAXIMUM_ROWS_READ = 100_000;
const MAXIMUM_ATTRIBUTE_VALUES_LISTED = 20;
/** A cumulative point looks this far back for the point before it, or one step if that is more. */
const MINIMUM_LOOKBACK_MILLISECONDS = 600_000;

function classifyValueKind(
  metricType: StoredMetricSeries["metricType"],
  temporality: StoredMetricSeries["temporality"],
  isMonotonic: boolean | null,
): ValueKind {
  if (metricType === "histogram") return "distribution";
  if (metricType === "gauge") return "level";
  // A cumulative non-monotonic sum, such as an up-down counter, says how much there is now.
  return temporality === "cumulative" && !isMonotonic ? "level" : "increment";
}

export function createMetricQueries(
  metricRepository: MetricRepository,
  readCurrentTime: () => Date,
): MetricQueries {
  return {
    async listMetrics(projectId) {
      const definitions = await metricRepository.listMetricDefinitions(
        projectId,
        MAXIMUM_METRIC_DEFINITIONS,
      );
      const summariesByIdentity = new Map<string, MetricSummary>();
      for (const definition of definitions) {
        const valueKind = classifyValueKind(
          definition.metricType,
          definition.temporality,
          definition.isMonotonic,
        );
        const identity = JSON.stringify([
          definition.metricName,
          definition.metricType,
          definition.unit,
          valueKind,
        ]);
        const knownSummary = summariesByIdentity.get(identity);
        if (knownSummary === undefined) {
          summariesByIdentity.set(identity, {
            name: definition.metricName,
            type: definition.metricType,
            unit: definition.unit,
            seriesCount: definition.seriesCount,
            supportedAggregations: SUPPORTED_AGGREGATIONS[valueKind],
          });
        } else {
          knownSummary.seriesCount += definition.seriesCount;
        }
      }
      return [...summariesByIdentity.values()];
    },

    async listMetricAttributes(projectId, metricName) {
      const allSeries = await metricRepository.listSeries(
        projectId,
        metricName,
        MAXIMUM_SERIES_SCANNED,
      );
      const attributesByKey = new Map<
        string,
        { source: MetricAttribute["source"]; values: Set<string> }
      >();
      const collectAttributes = (
        attributes: Record<string, unknown>,
        source: MetricAttribute["source"],
      ) => {
        for (const [key, attributeValue] of Object.entries(attributes)) {
          const knownAttribute = attributesByKey.get(key) ?? { source, values: new Set<string>() };
          if (knownAttribute.values.size < MAXIMUM_ATTRIBUTE_VALUES_LISTED) {
            knownAttribute.values.add(formatAttributeValue(attributeValue));
          }
          attributesByKey.set(key, knownAttribute);
        }
      };
      for (const series of allSeries) {
        collectAttributes(series.attributes, "metric");
      }
      for (const series of allSeries) {
        collectAttributes(series.resourceAttributes, "resource");
      }
      const attributes = [...attributesByKey].map(([key, { source, values }]) => ({
        key,
        source,
        values: [...values].sort(),
      }));
      attributes.sort((firstAttribute, secondAttribute) =>
        firstAttribute.key.localeCompare(secondAttribute.key)
      );
      return { attributes };
    },

    async queryMetric(projectId, query) {
      const timeAxis = createTimeAxis(query, readCurrentTime());
      const scannedSeries = await metricRepository.listSeries(
        projectId,
        query.metric,
        MAXIMUM_SERIES_SCANNED + 1,
      );
      if (scannedSeries.length > MAXIMUM_SERIES_SCANNED) {
        throw new MetricQueryError(
          "too_many_series",
          `This metric has more than ${MAXIMUM_SERIES_SCANNED} Time Series. Its cardinality is too high to query.`,
        );
      }
      const matchingSeries = filterSeries(scannedSeries, query);
      const emptyResponse: QueryMetricResponse = {
        metric: null,
        aggregation: query.aggregation,
        stepSeconds: timeAxis.stepSeconds,
        times: timeAxis.times,
        series: [],
      };
      if (matchingSeries.length === 0) return emptyResponse;
      if (matchingSeries.length > MAXIMUM_SERIES_CHARTED) {
        throw new MetricQueryError(
          "too_many_series",
          `The query matches more than ${MAXIMUM_SERIES_CHARTED} Time Series. Narrow it with serviceName or attribute filters.`,
        );
      }
      const valueKind = findSingleValueKind(matchingSeries, query.metric);
      if (!SUPPORTED_AGGREGATIONS[valueKind].includes(query.aggregation)) {
        throw new MetricQueryError(
          "unsupported_aggregation",
          `${query.aggregation} does not apply to the ${
            matchingSeries[0].metricType
          } metric ${query.metric}. ` +
            `Use ${SUPPORTED_AGGREGATIONS[valueKind].join(", ")}.`,
        );
      }

      const groupByKeys = readGroupByKeys(query.groupBy);
      const groups = groupSeries(matchingSeries, groupByKeys);
      const readRange = createReadRange(matchingSeries, timeAxis);
      if (valueKind === "distribution") {
        addHistogramPoints(
          groups,
          await readWithinLimit(metricRepository.readHistogramPoints(projectId, readRange)),
          timeAxis,
          readRange,
        );
      } else {
        const cumulativeSeriesIds = valueKind === "increment"
          ? matchingSeries.filter((series) => series.temporality === "cumulative")
            .map((series) => series.seriesId)
          : [];
        const cumulativeIdSet = new Set(cumulativeSeriesIds);
        const plainSeriesIds = readRange.seriesIds.filter((seriesId) =>
          !cumulativeIdSet.has(seriesId)
        );
        const [cumulativeTotals, plainTotals] = await Promise.all([
          cumulativeSeriesIds.length === 0 ? [] : readWithinLimit(
            metricRepository.readCumulativeStepTotals(projectId, {
              ...readRange,
              seriesIds: cumulativeSeriesIds,
            }),
          ),
          plainSeriesIds.length === 0 ? [] : readWithinLimit(
            metricRepository.readStepTotals(projectId, { ...readRange, seriesIds: plainSeriesIds }),
          ),
        ]);
        for (const stepTotals of [...cumulativeTotals, ...plainTotals]) {
          const stepCell = groups.findCell(stepTotals.seriesId, stepTotals.stepIndex);
          if (stepCell === null) continue;
          stepCell.valueTotal += stepTotals.valueTotal;
          stepCell.pointCount += stepTotals.pointCount;
          stepCell.seriesAverageTotal += stepTotals.valueTotal / stepTotals.pointCount;
        }
      }

      return {
        metric: summarizeSeries(matchingSeries, valueKind),
        aggregation: query.aggregation,
        stepSeconds: timeAxis.stepSeconds,
        times: timeAxis.times,
        series: groups.list().map(({ group, cells }) => ({
          group,
          values: timeAxis.times.map((_time, stepIndex) =>
            readCellValue(cells.get(stepIndex), query.aggregation, valueKind, timeAxis, stepIndex)
          ),
        })),
      };
    },
  };
}

async function readWithinLimit<Row>(reading: Promise<Row[]>): Promise<Row[]> {
  const rows = await reading;
  if (rows.length > MAXIMUM_ROWS_READ) {
    throw new MetricQueryError(
      "too_many_points",
      `The query reads more than ${MAXIMUM_ROWS_READ} data points. Narrow the time range, use a longer step or add filters.`,
    );
  }
  return rows;
}

interface TimeAxis {
  stepSeconds: number;
  stepMilliseconds: number;
  firstStepStartMilliseconds: number;
  endMilliseconds: number;
  times: string[];
}

function createTimeAxis(query: QueryMetricQuery, now: Date): TimeAxis {
  const endMilliseconds = query.to === undefined ? now.getTime() : Date.parse(query.to);
  const startMilliseconds = query.from === undefined
    ? endMilliseconds - MILLISECONDS_PER_HOUR
    : Date.parse(query.from);
  if (startMilliseconds >= endMilliseconds) {
    throw new MetricQueryError("invalid_time_range", "from must be earlier than to.");
  }
  const stepSeconds = query.stepSeconds ??
    chooseAutomaticStep((endMilliseconds - startMilliseconds) / MILLISECONDS_PER_SECOND);
  const stepMilliseconds = stepSeconds * MILLISECONDS_PER_SECOND;
  // Steps are aligned to the clock, so that a chart does not shift as its time range moves.
  const firstStepStartMilliseconds = Math.floor(startMilliseconds / stepMilliseconds) *
    stepMilliseconds;
  const stepCount = Math.ceil((endMilliseconds - firstStepStartMilliseconds) / stepMilliseconds);
  if (stepCount > MAXIMUM_STEP_COUNT) {
    throw new MetricQueryError(
      "too_many_steps",
      `The query has ${stepCount} steps, and at most ${MAXIMUM_STEP_COUNT} are allowed. Use a longer step or a shorter time range.`,
    );
  }
  return {
    stepSeconds,
    stepMilliseconds,
    firstStepStartMilliseconds,
    endMilliseconds,
    times: Array.from(
      { length: stepCount },
      (_time, stepIndex) =>
        new Date(firstStepStartMilliseconds + stepIndex * stepMilliseconds).toISOString(),
    ),
  };
}

function chooseAutomaticStep(rangeSeconds: number): number {
  const smallestStep = rangeSeconds / TARGET_AUTOMATIC_STEP_COUNT;
  return AUTOMATIC_STEP_SECONDS.find((stepSeconds) => stepSeconds >= smallestStep) ??
    AUTOMATIC_STEP_SECONDS[AUTOMATIC_STEP_SECONDS.length - 1];
}

function createReadRange(series: StoredMetricSeries[], timeAxis: TimeAxis): MetricReadRange {
  const lookbackMilliseconds = Math.max(MINIMUM_LOOKBACK_MILLISECONDS, timeAxis.stepMilliseconds);
  return {
    seriesIds: series.map(({ seriesId }) => seriesId),
    firstStepStartUnixNano: BigInt(timeAxis.firstStepStartMilliseconds) *
      NANOSECONDS_PER_MILLISECOND,
    stepNanoseconds: BigInt(timeAxis.stepMilliseconds) * NANOSECONDS_PER_MILLISECOND,
    endUnixNano: BigInt(timeAxis.endMilliseconds) * NANOSECONDS_PER_MILLISECOND,
    lookbackStartUnixNano: BigInt(timeAxis.firstStepStartMilliseconds - lookbackMilliseconds) *
      NANOSECONDS_PER_MILLISECOND,
    maximumRowCount: MAXIMUM_ROWS_READ + 1,
  };
}

/** An attribute of the data point, or else of the application that sent it. */
function readSeriesAttribute(series: StoredMetricSeries, key: string): unknown {
  return series.attributes[key] ?? series.resourceAttributes[key];
}

function formatAttributeValue(attributeValue: unknown): string {
  return typeof attributeValue === "string" ? attributeValue : JSON.stringify(attributeValue);
}

function filterSeries(
  allSeries: StoredMetricSeries[],
  query: QueryMetricQuery,
): StoredMetricSeries[] {
  const attributeFilters = parseAttributeFilters(query.attribute);
  return allSeries.filter((series) =>
    (query.serviceName === undefined || series.serviceName === query.serviceName) &&
    attributeFilters.every(({ key, value }) => {
      const attributeValue = readSeriesAttribute(series, key);
      return attributeValue !== undefined && formatAttributeValue(attributeValue) === value;
    })
  );
}

function findSingleValueKind(series: StoredMetricSeries[], metricName: string): ValueKind {
  const definitions = new Set(
    series.map((candidate) =>
      JSON.stringify([
        classifyValueKind(candidate.metricType, candidate.temporality, candidate.isMonotonic),
        candidate.unit,
      ])
    ),
  );
  if (definitions.size > 1) {
    throw new MetricQueryError(
      "ambiguous_metric",
      `${metricName} is reported with different types or units. Narrow the query to one with serviceName or attribute filters.`,
    );
  }
  return classifyValueKind(series[0].metricType, series[0].temporality, series[0].isMonotonic);
}

function summarizeSeries(series: StoredMetricSeries[], valueKind: ValueKind): MetricSummary {
  return {
    name: series[0].metricName,
    type: series[0].metricType,
    unit: series[0].unit,
    seriesCount: series.length,
    supportedAggregations: SUPPORTED_AGGREGATIONS[valueKind],
  };
}

function readGroupByKeys(groupBy: QueryMetricQuery["groupBy"]): string[] {
  return groupBy === undefined ? [] : Array.isArray(groupBy) ? groupBy : [groupBy];
}

/** What is known about one group in one step. */
interface StepCell {
  /** The values added together, or a histogram's sum of observations. */
  valueTotal: number;
  pointCount: number;
  /** Each series' average in the step, added up, because a gauge's level counts once per series. */
  seriesAverageTotal: number;
  observationCount: number;
  hasObservationSum: boolean;
  countsByUpperBound: Map<number, number>;
}

interface ResultGroup {
  group: Record<string, string | null>;
  cells: Map<number, StepCell>;
}

interface ResultGroups {
  findCell(seriesId: string, stepIndex: number): StepCell | null;
  findSeries(seriesId: string): StoredMetricSeries | null;
  list(): ResultGroup[];
}

function groupSeries(series: StoredMetricSeries[], groupByKeys: string[]): ResultGroups {
  const groupsByIdentity = new Map<string, ResultGroup>();
  const groupsBySeriesId = new Map<string, ResultGroup>();
  const seriesById = new Map(series.map((candidate) => [candidate.seriesId, candidate]));
  for (const candidate of series) {
    const groupEntries = groupByKeys.map((key): [string, string | null] => {
      const attributeValue = readSeriesAttribute(candidate, key);
      return [key, attributeValue === undefined ? null : formatAttributeValue(attributeValue)];
    });
    const identity = JSON.stringify(groupEntries);
    const resultGroup = groupsByIdentity.get(identity) ?? {
      group: Object.fromEntries(groupEntries),
      cells: new Map<number, StepCell>(),
    };
    groupsByIdentity.set(identity, resultGroup);
    groupsBySeriesId.set(candidate.seriesId, resultGroup);
  }
  return {
    findCell(seriesId, stepIndex) {
      const resultGroup = groupsBySeriesId.get(seriesId);
      if (resultGroup === undefined) return null;
      const knownCell = resultGroup.cells.get(stepIndex);
      if (knownCell !== undefined) return knownCell;
      const newCell: StepCell = {
        valueTotal: 0,
        pointCount: 0,
        seriesAverageTotal: 0,
        observationCount: 0,
        hasObservationSum: false,
        countsByUpperBound: new Map(),
      };
      resultGroup.cells.set(stepIndex, newCell);
      return newCell;
    },
    findSeries: (seriesId) => seriesById.get(seriesId) ?? null,
    list: () =>
      [...groupsByIdentity.values()].sort((firstGroup, secondGroup) =>
        JSON.stringify(firstGroup.group).localeCompare(JSON.stringify(secondGroup.group))
      ),
  };
}

function addHistogramPoints(
  groups: ResultGroups,
  points: StoredHistogramPoint[],
  timeAxis: TimeAxis,
  readRange: MetricReadRange,
): void {
  const earliestRecentStart = formatUnixNanosecondsForStorage(readRange.lookbackStartUnixNano);
  for (const point of points) {
    const series = groups.findSeries(point.seriesId);
    const stepCell = groups.findCell(point.seriesId, point.stepIndex);
    if (series === null || stepCell === null || point.stepIndex >= timeAxis.times.length) continue;
    const increase = series.temporality === "cumulative"
      ? computeHistogramIncrease(point, earliestRecentStart)
      : point.current;
    if (increase === null) continue;
    stepCell.pointCount += 1;
    stepCell.observationCount += increase.count;
    if (increase.sum !== null) {
      stepCell.valueTotal += increase.sum;
      stepCell.hasObservationSum = true;
    }
    addBucketCounts(stepCell, series.explicitBounds ?? [], increase.bucketCounts);
  }
}

/** The same rules for a cumulative value as `readCumulativeStepTotals` applies in SQL. */
function computeHistogramIncrease(
  point: StoredHistogramPoint,
  earliestRecentStart: string,
): StoredHistogramCounts | null {
  const { current, previous } = point;
  if (previous === null) {
    return point.startTimeUnixNano !== null && point.startTimeUnixNano >= earliestRecentStart
      ? current
      : null;
  }
  const hasRestarted = point.startTimeUnixNano !== null &&
    point.previousStartTimeUnixNano !== null &&
    point.startTimeUnixNano !== point.previousStartTimeUnixNano;
  if (current.count < previous.count || hasRestarted) return current;
  return {
    count: current.count - previous.count,
    sum: current.sum === null || previous.sum === null ? null : current.sum - previous.sum,
    bucketCounts: current.bucketCounts.map((bucketCount, bucketIndex) =>
      bucketCount - (previous.bucketCounts[bucketIndex] ?? 0)
    ),
  };
}

/**
 * Keeps each count at its bucket's upper bound. Series with the same bounds then add up exactly;
 * series with different bounds merge into their union, which is only as precise as the coarsest.
 */
function addBucketCounts(
  stepCell: StepCell,
  explicitBounds: number[],
  bucketCounts: number[],
): void {
  bucketCounts.forEach((bucketCount, bucketIndex) => {
    const upperBound = explicitBounds[bucketIndex] ?? Infinity;
    stepCell.countsByUpperBound.set(
      upperBound,
      (stepCell.countsByUpperBound.get(upperBound) ?? 0) + bucketCount,
    );
  });
}

function readCellValue(
  stepCell: StepCell | undefined,
  aggregation: MetricAggregation,
  valueKind: ValueKind,
  timeAxis: TimeAxis,
  stepIndex: number,
): number | null {
  if (stepCell === undefined) return null;
  // The last step may end at `to`, and dividing by a whole step would understate its rate.
  const stepEndMilliseconds = Math.min(
    timeAxis.firstStepStartMilliseconds + (stepIndex + 1) * timeAxis.stepMilliseconds,
    timeAxis.endMilliseconds,
  );
  const stepStartMilliseconds = timeAxis.firstStepStartMilliseconds +
    stepIndex * timeAxis.stepMilliseconds;
  const elapsedSeconds = (stepEndMilliseconds - stepStartMilliseconds) / MILLISECONDS_PER_SECOND;

  if (valueKind === "distribution") {
    if (aggregation === "p95") {
      return estimateHistogramQuantile(P95_QUANTILE, stepCell.countsByUpperBound);
    }
    if (aggregation === "rate") return stepCell.observationCount / elapsedSeconds;
    if (!stepCell.hasObservationSum) return null;
    if (aggregation === "sum") return stepCell.valueTotal;
    return stepCell.observationCount === 0 ? null : stepCell.valueTotal / stepCell.observationCount;
  }
  if (aggregation === "rate") return stepCell.valueTotal / elapsedSeconds;
  if (aggregation === "avg") return stepCell.valueTotal / stepCell.pointCount;
  return valueKind === "level" ? stepCell.seriesAverageTotal : stepCell.valueTotal;
}
