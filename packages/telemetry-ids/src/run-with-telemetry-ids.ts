import { type BaggageEntry, context, propagation } from "@opentelemetry/api";
import { CORRELATION_ID_ATTRIBUTE, SESSION_ID_ATTRIBUTE } from "./telemetry-id-attributes.ts";

export interface TelemetryIds {
  correlationId: string;
  sessionId?: string;
}

/**
 * Runs `operation` with the Correlation ID and optional Session ID in OTel baggage, so that
 * `TelemetryIdsSpanProcessor` copies them onto every span created inside it.
 */
export function runWithTelemetryIds<OperationResult>(
  telemetryIds: TelemetryIds,
  operation: () => OperationResult,
): OperationResult {
  const baggageEntries: Record<string, BaggageEntry> = {
    [CORRELATION_ID_ATTRIBUTE]: { value: telemetryIds.correlationId },
  };
  if (telemetryIds.sessionId) {
    baggageEntries[SESSION_ID_ATTRIBUTE] = { value: telemetryIds.sessionId };
  }
  const existingBaggage = propagation.getBaggage(context.active());
  const mergedBaggage = existingBaggage
    ? Object.entries(baggageEntries).reduce(
      (baggage, [key, entry]) => baggage.setEntry(key, entry),
      existingBaggage,
    )
    : propagation.createBaggage(baggageEntries);
  return context.with(propagation.setBaggage(context.active(), mergedBaggage), operation);
}
