/** Public entry point of the storage module: the only file other modules import. */
export { createLogRepository, type LogRepository } from "./log-repository.ts";
export {
  createMetricRepository,
  type MetricReadRange,
  type MetricRepository,
  type StoredHistogramCounts,
  type StoredHistogramPoint,
  type StoredMetricSeries,
} from "./metric-repository.ts";
export {
  createRejectionRepository,
  type RecordedRejections,
  type RejectionRepository,
} from "./rejection-repository.ts";
export { createRetentionRepository, type RetentionRepository } from "./retention-repository.ts";
export { formatUnixNanosecondsForStorage } from "./span-record-entity.ts";
export { createSpanRepository, type SpanRepository } from "./span-repository.ts";
export {
  migrateTelemetryDatabase,
  openTelemetryDatabase,
  type TelemetryDatabase,
} from "./telemetry-database.ts";
