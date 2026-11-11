import type { SpanRepository } from "../storage/mod.ts";
import { applyCorrelationPolicy } from "./correlation-policy.ts";
import type { OtlpExportTraceRequest, TraceExportOutcome } from "./otlp-trace-types.ts";
import type { RejectionRecorder } from "./rejection-recorder.ts";
import { normalizeTraceRequest, type SpanRejection } from "./span-normalization.ts";

export interface TraceIngestion {
  ingestTraces(projectId: string, request: OtlpExportTraceRequest): Promise<TraceExportOutcome>;
}

const MAXIMUM_EXAMPLE_SPAN_NAMES = 3;

export function createTraceIngestion(
  spanRepository: SpanRepository,
  rejectionRecorder: RejectionRecorder,
  readCurrentTime: () => Date,
): TraceIngestion {
  return {
    async ingestTraces(projectId, request) {
      const normalizationResult = normalizeTraceRequest(request);
      const policyResult = applyCorrelationPolicy(normalizationResult.spans);
      const receivedAt = readCurrentTime();
      if (policyResult.acceptedSpans.length > 0) {
        await spanRepository.insertSpans(projectId, policyResult.acceptedSpans, receivedAt);
      }
      const allRejections = [...normalizationResult.rejections, ...policyResult.rejections];
      if (allRejections.length === 0) {
        return { rejectedSpanCount: 0, errorMessage: null };
      }
      const errorMessage = describeRejections(allRejections);
      await rejectionRecorder.recordRejections({
        projectId,
        signal: "spans",
        rejectedCount: allRejections.length,
        reason: errorMessage,
        rejectedAt: receivedAt,
      });
      return { rejectedSpanCount: allRejections.length, errorMessage };
    },
  };
}

/** Builds a message such as `2 spans rejected: missing required attribute correlation.id (2)`. */
function describeRejections(rejections: SpanRejection[]): string {
  const spanNamesByReason = new Map<string, string[]>();
  for (const rejection of rejections) {
    const spanNames = spanNamesByReason.get(rejection.reason) ?? [];
    spanNames.push(rejection.spanName);
    spanNamesByReason.set(rejection.reason, spanNames);
  }
  const reasonDescriptions = [...spanNamesByReason].map(([reason, spanNames]) => {
    const exampleNames = spanNames.slice(0, MAXIMUM_EXAMPLE_SPAN_NAMES).map((spanName) =>
      `"${spanName}"`
    ).join(", ");
    return `${reason} (${spanNames.length}, for example ${exampleNames})`;
  });
  const spanWord = rejections.length === 1 ? "span" : "spans";
  return `${rejections.length} ${spanWord} rejected: ${reasonDescriptions.join("; ")}`;
}
