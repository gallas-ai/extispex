import type { EntityManager } from "@mikro-orm/sql";
import type {
  IncomingMetricPoint,
  IncomingMetricSeries,
  MetricTemporality,
  MetricType,
} from "../ingestion/mod.ts";
import { createDailyPartitions } from "./daily-partitions.ts";
import { formatUnixNanosecondsForStorage } from "./span-record-entity.ts";
import type { TelemetryDatabase } from "./telemetry-database.ts";

/** One Time Series as stored. */
export interface StoredMetricSeries {
  seriesId: string;
  metricName: string;
  metricType: MetricType;
  unit: string;
  temporality: MetricTemporality | null;
  isMonotonic: boolean | null;
  explicitBounds: number[] | null;
  serviceName: string | null;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
}

/** A metric's Time Series that share a definition, counted. */
export interface StoredMetricDefinition {
  metricName: string;
  metricType: MetricType;
  unit: string;
  temporality: MetricTemporality | null;
  isMonotonic: boolean | null;
  seriesCount: number;
}

/** Which points to read, and how to cut them into steps. */
export interface MetricReadRange {
  seriesIds: string[];
  /** The start of the first step. Earlier points are not returned. */
  firstStepStartUnixNano: bigint;
  stepNanoseconds: bigint;
  endUnixNano: bigint;
  /** How far back a cumulative point may find the point before it. */
  lookbackStartUnixNano: bigint;
  maximumRowCount: number;
}

/** The values of one Time Series in one step. */
export interface MetricStepTotals {
  seriesId: string;
  stepIndex: number;
  valueTotal: number;
  pointCount: number;
}

export interface StoredHistogramCounts {
  count: number;
  sum: number | null;
  bucketCounts: number[];
}

/** One histogram point, with the point of the same Time Series before it, if any. */
export interface StoredHistogramPoint {
  seriesId: string;
  stepIndex: number;
  startTimeUnixNano: string | null;
  current: StoredHistogramCounts;
  previousStartTimeUnixNano: string | null;
  previous: StoredHistogramCounts | null;
}

export interface MetricRepository {
  /** Stores points, ignoring any already stored, because exporters retry whole batches. */
  insertMetricPoints(
    projectId: string,
    series: IncomingMetricSeries[],
    points: IncomingMetricPoint[],
    receivedAt: Date,
  ): Promise<void>;
  listMetricDefinitions(
    projectId: string,
    maximumRowCount: number,
  ): Promise<StoredMetricDefinition[]>;
  listSeries(
    projectId: string,
    metricName: string,
    maximumRowCount: number,
  ): Promise<StoredMetricSeries[]>;
  /** Sums each series' values per step, for values that can be added as they are stored. */
  readStepTotals(projectId: string, range: MetricReadRange): Promise<MetricStepTotals[]>;
  /** Sums each series' increases per step, for cumulative values that only grow until a reset. */
  readCumulativeStepTotals(projectId: string, range: MetricReadRange): Promise<MetricStepTotals[]>;
  readHistogramPoints(projectId: string, range: MetricReadRange): Promise<StoredHistogramPoint[]>;
}

/** Keeps one statement well below PostgreSQL's limit of 65,535 parameters and SQLite's 32,766. */
const INSERT_BATCH_ROW_COUNT = 500;

interface MetricSeriesRow {
  series_id: string;
  metric_name: string;
  metric_type: MetricType;
  unit: string;
  temporality: MetricTemporality | null;
  is_monotonic: boolean | number | null;
  explicit_bounds: string | null;
  service_name: string | null;
  attributes: unknown;
  resource_attributes: unknown;
}

interface MetricDefinitionRow {
  metric_name: string;
  metric_type: MetricType;
  unit: string;
  temporality: MetricTemporality | null;
  is_monotonic: boolean | number | null;
  series_count: number | string;
}

interface StepTotalsRow {
  series_id: string;
  step_index: number | string;
  value_total: number | string;
  point_count: number | string;
}

interface HistogramPointRow {
  series_id: string;
  step_index: number | string;
  start_time_unix_nano: string | null;
  histogram_count: number | string;
  histogram_sum: number | string | null;
  bucket_counts: string;
  previous_start_time_unix_nano: string | null;
  previous_count: number | string | null;
  previous_sum: number | string | null;
  previous_bucket_counts: string | null;
}

/** Whole steps since the first one. Both databases divide 64-bit integers without a remainder. */
const STEP_INDEX_EXPRESSION =
  "(cast(time_unix_nano as bigint) - cast(? as bigint)) / cast(? as bigint)";

export function createMetricRepository(database: TelemetryDatabase): MetricRepository {
  const metricPartitions = createDailyPartitions(database, "metric_points");
  const isPostgres = database.dialect === "postgresql";

  return {
    async insertMetricPoints(projectId, series, points, receivedAt) {
      await metricPartitions.ensurePartitionsFor(points.map((point) => point.timeUnixNano));
      // Always in the same order, so that two batches updating the same series cannot deadlock.
      const sortedSeries = [...series].sort((firstSeries, secondSeries) =>
        firstSeries.seriesId < secondSeries.seriesId ? -1 : 1
      );
      await database.orm.em.fork().transactional(async (entityManager) => {
        for (let rowIndex = 0; rowIndex < sortedSeries.length; rowIndex += INSERT_BATCH_ROW_COUNT) {
          await upsertSeriesRows(
            entityManager,
            isPostgres,
            projectId,
            sortedSeries.slice(rowIndex, rowIndex + INSERT_BATCH_ROW_COUNT),
          );
        }
        for (let rowIndex = 0; rowIndex < points.length; rowIndex += INSERT_BATCH_ROW_COUNT) {
          await insertPointRows(
            entityManager,
            projectId,
            points.slice(rowIndex, rowIndex + INSERT_BATCH_ROW_COUNT),
            receivedAt,
          );
        }
      });
    },

    async listMetricDefinitions(projectId, maximumRowCount) {
      const rows = await database.orm.em.fork().execute<MetricDefinitionRow[]>(
        `select metric_name, metric_type, unit, temporality, is_monotonic,
            count(*) as series_count
          from metric_series
          where project_id = ?
          group by metric_name, metric_type, unit, temporality, is_monotonic
          order by metric_name
          limit ?`,
        [projectId, maximumRowCount],
      );
      return rows.map((row) => ({
        metricName: row.metric_name,
        metricType: row.metric_type,
        unit: row.unit,
        temporality: row.temporality,
        isMonotonic: readNullableBoolean(row.is_monotonic),
        seriesCount: Number(row.series_count),
      }));
    },

    async listSeries(projectId, metricName, maximumRowCount) {
      const rows = await database.orm.em.fork().execute<MetricSeriesRow[]>(
        `select series_id, metric_name, metric_type, unit, temporality, is_monotonic,
            explicit_bounds, service_name, attributes, resource_attributes
          from metric_series
          where project_id = ? and metric_name = ?
          limit ?`,
        [projectId, metricName, maximumRowCount],
      );
      return rows.map(convertRowToSeries);
    },

    async readStepTotals(projectId, range) {
      const rows = await database.orm.em.fork().execute<StepTotalsRow[]>(
        `select series_id, ${STEP_INDEX_EXPRESSION} as step_index,
            sum(value) as value_total, count(*) as point_count
          from metric_points
          where project_id = ? and series_id in (${createPlaceholders(range.seriesIds)})
            and time_unix_nano >= ? and time_unix_nano < ? and value is not null
          group by series_id, step_index
          limit ?`,
        [
          ...readStepParameters(range),
          projectId,
          ...range.seriesIds,
          formatUnixNanosecondsForStorage(range.firstStepStartUnixNano),
          formatUnixNanosecondsForStorage(range.endUnixNano),
          range.maximumRowCount,
        ],
      );
      return rows.map(convertRowToStepTotals);
    },

    async readCumulativeStepTotals(projectId, range) {
      // A point without one before it counts only when its counter started recently: otherwise
      // nothing says how much of its value falls into this time range.
      const rows = await database.orm.em.fork().execute<StepTotalsRow[]>(
        `select series_id, step_index, sum(increase) as value_total, count(*) as point_count
          from (
            select series_id, time_unix_nano, ${STEP_INDEX_EXPRESSION} as step_index,
              case
                when previous_value is null then
                  case when start_time_unix_nano >= ? then value end
                when value < previous_value or start_time_unix_nano <> previous_start_time
                  then value
                else value - previous_value
              end as increase
            from (
              select series_id, time_unix_nano, start_time_unix_nano, value,
                lag(value) over series_points as previous_value,
                lag(start_time_unix_nano) over series_points as previous_start_time
              from metric_points
              where project_id = ? and series_id in (${createPlaceholders(range.seriesIds)})
                and time_unix_nano >= ? and time_unix_nano < ? and value is not null
              window series_points as (partition by series_id order by time_unix_nano)
            ) as points_with_previous
          ) as point_increases
          where time_unix_nano >= ? and increase is not null
          group by series_id, step_index
          limit ?`,
        [
          ...readStepParameters(range),
          formatUnixNanosecondsForStorage(range.lookbackStartUnixNano),
          projectId,
          ...range.seriesIds,
          formatUnixNanosecondsForStorage(range.lookbackStartUnixNano),
          formatUnixNanosecondsForStorage(range.endUnixNano),
          formatUnixNanosecondsForStorage(range.firstStepStartUnixNano),
          range.maximumRowCount,
        ],
      );
      return rows.map(convertRowToStepTotals);
    },

    async readHistogramPoints(projectId, range) {
      const rows = await database.orm.em.fork().execute<HistogramPointRow[]>(
        `select series_id, ${STEP_INDEX_EXPRESSION} as step_index, start_time_unix_nano,
            histogram_count, histogram_sum, bucket_counts, previous_start_time_unix_nano,
            previous_count, previous_sum, previous_bucket_counts
          from (
            select series_id, time_unix_nano, start_time_unix_nano, histogram_count,
              histogram_sum, bucket_counts,
              lag(start_time_unix_nano) over series_points as previous_start_time_unix_nano,
              lag(histogram_count) over series_points as previous_count,
              lag(histogram_sum) over series_points as previous_sum,
              lag(bucket_counts) over series_points as previous_bucket_counts
            from metric_points
            where project_id = ? and series_id in (${createPlaceholders(range.seriesIds)})
              and time_unix_nano >= ? and time_unix_nano < ? and histogram_count is not null
            window series_points as (partition by series_id order by time_unix_nano)
          ) as points_with_previous
          where time_unix_nano >= ?
          limit ?`,
        [
          ...readStepParameters(range),
          projectId,
          ...range.seriesIds,
          formatUnixNanosecondsForStorage(range.lookbackStartUnixNano),
          formatUnixNanosecondsForStorage(range.endUnixNano),
          formatUnixNanosecondsForStorage(range.firstStepStartUnixNano),
          range.maximumRowCount,
        ],
      );
      return rows.map(convertRowToHistogramPoint);
    },
  };
}

async function upsertSeriesRows(
  entityManager: EntityManager,
  isPostgres: boolean,
  projectId: string,
  seriesRows: IncomingMetricSeries[],
): Promise<void> {
  const jsonPlaceholder = isPostgres ? "?::jsonb" : "?";
  const rowPlaceholder = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ${jsonPlaceholder}, ${jsonPlaceholder}, ?)`;
  await entityManager.execute(
    `insert into metric_series (project_id, series_id, metric_name, metric_type, unit,
        temporality, is_monotonic, explicit_bounds, service_name, attributes,
        resource_attributes, last_seen_unix_nano)
      values ${seriesRows.map(() => rowPlaceholder).join(", ")}
      on conflict (project_id, series_id) do update
        set last_seen_unix_nano = excluded.last_seen_unix_nano
        where metric_series.last_seen_unix_nano < excluded.last_seen_unix_nano`,
    seriesRows.flatMap((series) => [
      projectId,
      series.seriesId,
      series.metricName,
      series.metricType,
      series.unit,
      series.temporality,
      series.isMonotonic,
      series.explicitBounds === null ? null : JSON.stringify(series.explicitBounds),
      series.serviceName,
      JSON.stringify(series.attributes),
      JSON.stringify(series.resourceAttributes),
      formatUnixNanosecondsForStorage(series.lastSeenUnixNano),
    ]),
  );
}

async function insertPointRows(
  entityManager: EntityManager,
  projectId: string,
  pointRows: IncomingMetricPoint[],
  receivedAt: Date,
): Promise<void> {
  await entityManager.execute(
    `insert into metric_points (project_id, series_id, time_unix_nano, start_time_unix_nano,
        value, histogram_count, histogram_sum, bucket_counts, received_at)
      values ${pointRows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
      on conflict (project_id, series_id, time_unix_nano) do nothing`,
    pointRows.flatMap((point) => [
      projectId,
      point.seriesId,
      formatUnixNanosecondsForStorage(point.timeUnixNano),
      point.startTimeUnixNano === null
        ? null
        : formatUnixNanosecondsForStorage(point.startTimeUnixNano),
      point.value,
      point.histogram?.count ?? null,
      point.histogram?.sum ?? null,
      point.histogram === null ? null : JSON.stringify(point.histogram.bucketCounts),
      receivedAt.toISOString(),
    ]),
  );
}

function createPlaceholders(values: unknown[]): string {
  return values.map(() => "?").join(", ");
}

function readStepParameters(range: MetricReadRange): string[] {
  return [
    range.firstStepStartUnixNano.toString(),
    range.stepNanoseconds.toString(),
  ];
}

function readNullableBoolean(columnValue: boolean | number | null): boolean | null {
  return columnValue === null ? null : Boolean(columnValue);
}

function parseJsonColumn(columnValue: unknown): unknown {
  return typeof columnValue === "string" ? JSON.parse(columnValue) : columnValue;
}

function convertRowToSeries(row: MetricSeriesRow): StoredMetricSeries {
  return {
    seriesId: row.series_id,
    metricName: row.metric_name,
    metricType: row.metric_type,
    unit: row.unit,
    temporality: row.temporality,
    isMonotonic: readNullableBoolean(row.is_monotonic),
    explicitBounds: row.explicit_bounds === null
      ? null
      : JSON.parse(row.explicit_bounds) as number[],
    serviceName: row.service_name,
    attributes: parseJsonColumn(row.attributes) as Record<string, unknown>,
    resourceAttributes: parseJsonColumn(row.resource_attributes) as Record<string, unknown>,
  };
}

function convertRowToStepTotals(row: StepTotalsRow): MetricStepTotals {
  return {
    seriesId: row.series_id,
    stepIndex: Number(row.step_index),
    valueTotal: Number(row.value_total),
    pointCount: Number(row.point_count),
  };
}

function convertRowToHistogramPoint(row: HistogramPointRow): StoredHistogramPoint {
  return {
    seriesId: row.series_id,
    stepIndex: Number(row.step_index),
    startTimeUnixNano: row.start_time_unix_nano,
    current: {
      count: Number(row.histogram_count),
      sum: row.histogram_sum === null ? null : Number(row.histogram_sum),
      bucketCounts: JSON.parse(row.bucket_counts) as number[],
    },
    previousStartTimeUnixNano: row.previous_start_time_unix_nano,
    previous: row.previous_count === null || row.previous_bucket_counts === null ? null : {
      count: Number(row.previous_count),
      sum: row.previous_sum === null ? null : Number(row.previous_sum),
      bucketCounts: JSON.parse(row.previous_bucket_counts) as number[],
    },
  };
}
