/** Public entry point of the ingestion module: the only file other modules import. */
export type { CorrelatedSpan } from "./correlation-policy.ts";
export { createLogIngestion } from "./log-ingestion.ts";
export type { IncomingLogRecord } from "./log-normalization.ts";
export { createMetricIngestion } from "./metric-ingestion.ts";
export type {
  IncomingMetricPoint,
  IncomingMetricSeries,
  MetricTemporality,
  MetricType,
} from "./metric-normalization.ts";
export {
  bindOtlpGrpcServer,
  createOtlpGrpcServer,
  type GrpcTlsFiles,
  shutdownOtlpGrpcServer,
} from "./otlp-grpc-server.ts";
export { registerOtlpHttpRoutes } from "./otlp-http-routes.ts";
export { OLDEST_ACCEPTED_RECORD_AGE_DAYS } from "./record-time-window.ts";
export { createRejectionRecorder } from "./rejection-recorder.ts";
export { makeTextStorable } from "./stored-text.ts";
export { createTraceIngestion } from "./trace-ingestion.ts";
