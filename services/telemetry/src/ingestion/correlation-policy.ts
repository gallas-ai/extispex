import { CORRELATION_ID_ATTRIBUTE, SESSION_ID_ATTRIBUTE } from "@extispex/telemetry-ids/attributes";
import type { IncomingSpan, SpanRejection } from "./span-normalization.ts";

export interface CorrelatedSpan extends IncomingSpan {
  correlationId: string;
  sessionId: string | null;
}

export interface CorrelationPolicyResult {
  acceptedSpans: CorrelatedSpan[];
  rejections: SpanRejection[];
}

/**
 * Every span must carry a Correlation ID so that it can always be found. The check runs on each
 * span, because spans of one trace can arrive in different batches.
 */
export function applyCorrelationPolicy(spans: IncomingSpan[]): CorrelationPolicyResult {
  const result: CorrelationPolicyResult = { acceptedSpans: [], rejections: [] };
  for (const span of spans) {
    const correlationId = readNonEmptyString(span.attributes[CORRELATION_ID_ATTRIBUTE]);
    if (correlationId === null) {
      result.rejections.push({
        spanName: span.name,
        reason: `missing required attribute ${CORRELATION_ID_ATTRIBUTE}`,
      });
      continue;
    }
    result.acceptedSpans.push({
      ...span,
      correlationId,
      sessionId: readNonEmptyString(span.attributes[SESSION_ID_ATTRIBUTE]),
    });
  }
  return result;
}

function readNonEmptyString(attributeValue: unknown): string | null {
  return typeof attributeValue === "string" && attributeValue.trim() !== "" ? attributeValue : null;
}
