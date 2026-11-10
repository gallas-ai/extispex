import type { MetricRepository } from "../storage/metric-repository.ts";
import { normalizeMetricsRequest } from "./metric-normalization.ts";
import type { MetricsExportOutcome, OtlpExportMetricsRequest } from "./otlp-metric-types.ts";
import { describeRejections, type RejectionRecorder } from "./rejection-recorder.ts";

export interface MetricIngestion {
  ingestMetrics(
    projectId: string,
    request: OtlpExportMetricsRequest,
  ): Promise<MetricsExportOutcome>;
}

export function createMetricIngestion(
  metricRepository: MetricRepository,
  rejectionRecorder: RejectionRecorder,
  readCurrentTime: () => Date,
): MetricIngestion {
  return {
    async ingestMetrics(projectId, request) {
      const receivedAt = readCurrentTime();
      const { series, points, rejectionReasons } = normalizeMetricsRequest(request, receivedAt);
      if (points.length > 0) {
        await metricRepository.insertMetricPoints(projectId, series, points, receivedAt);
      }
      if (rejectionReasons.length === 0) {
        return { rejectedDataPointCount: 0, errorMessage: null };
      }
      const errorMessage = describeRejections(rejectionReasons, "data point", "data points");
      await rejectionRecorder.recordRejections({
        projectId,
        signal: "metrics",
        rejectedCount: rejectionReasons.length,
        reason: errorMessage,
        rejectedAt: receivedAt,
      });
      return { rejectedDataPointCount: rejectionReasons.length, errorMessage };
    },
  };
}
