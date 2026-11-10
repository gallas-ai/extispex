import { z } from "zod";
import { attributeFiltersSchema } from "./attribute-filter.ts";

export const metricTypeSchema = z.enum(["sum", "gauge", "histogram"]);
export const metricAggregationSchema = z.enum(["sum", "avg", "rate", "p95"]);

export const metricSummarySchema = z.object({
  name: z.string(),
  type: metricTypeSchema,
  unit: z.string(),
  /** How many Time Series the metric has. */
  seriesCount: z.number().int(),
  /** The aggregations that mean something for this metric. */
  supportedAggregations: z.array(metricAggregationSchema),
});

export const listMetricsResponseSchema = z.object({
  metrics: z.array(metricSummarySchema),
});

export const listMetricAttributesQuerySchema = z.object({
  metric: z.string().min(1).max(255),
});

export const metricAttributeSchema = z.object({
  key: z.string(),
  /** `metric` for the data point's own attributes, `resource` for those of its application. */
  source: z.enum(["metric", "resource"]),
  /** Some of the attribute's values, sorted. */
  values: z.array(z.string()),
});

export const listMetricAttributesResponseSchema = z.object({
  attributes: z.array(metricAttributeSchema),
});

const isoTimeSchema = z.iso.datetime({ offset: true });
const groupByKeySchema = z.string().min(1).max(255);

export const MAXIMUM_METRIC_GROUP_BY_KEYS = 3;

export const queryMetricQuerySchema = z.object({
  metric: z.string().min(1).max(255),
  aggregation: metricAggregationSchema,
  /** Points at or after this time; one hour before `to` when left out. */
  from: isoTimeSchema.optional(),
  /** Points before this time; now when left out. */
  to: isoTimeSchema.optional(),
  /** The width of one point on the chart; chosen from the time range when left out. */
  stepSeconds: z.coerce.number().int().min(1).max(86_400).optional(),
  serviceName: z.string().min(1).optional(),
  attribute: attributeFiltersSchema.optional(),
  /** Attribute keys that split the result into one series per combination of values. */
  groupBy: z.union([
    groupByKeySchema,
    z.array(groupByKeySchema).max(MAXIMUM_METRIC_GROUP_BY_KEYS),
  ]).optional(),
});

export const metricResultSeriesSchema = z.object({
  /** The value of each `groupBy` key, or null where a Time Series does not have the attribute. */
  group: z.record(z.string(), z.string().nullable()),
  /** One value per entry of `times`; null where there is no data. */
  values: z.array(z.number().nullable()),
});

export const queryMetricResponseSchema = z.object({
  /** Null when the Project has no metric of this name. */
  metric: metricSummarySchema.nullable(),
  aggregation: metricAggregationSchema,
  stepSeconds: z.number().int(),
  /** The start of each step, oldest first. */
  times: z.array(z.string()),
  series: z.array(metricResultSeriesSchema),
});

export type MetricType = z.infer<typeof metricTypeSchema>;
export type MetricAggregation = z.infer<typeof metricAggregationSchema>;
export type MetricSummary = z.infer<typeof metricSummarySchema>;
export type ListMetricsResponse = z.infer<typeof listMetricsResponseSchema>;
export type MetricAttribute = z.infer<typeof metricAttributeSchema>;
export type ListMetricAttributesResponse = z.infer<typeof listMetricAttributesResponseSchema>;
export type QueryMetricQuery = z.infer<typeof queryMetricQuerySchema>;
export type MetricResultSeries = z.infer<typeof metricResultSeriesSchema>;
export type QueryMetricResponse = z.infer<typeof queryMetricResponseSchema>;
