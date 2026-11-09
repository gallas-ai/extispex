import { type Context, propagation } from "@opentelemetry/api";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { CORRELATION_ID_ATTRIBUTE, SESSION_ID_ATTRIBUTE } from "./telemetry-id-attributes.ts";

const COPIED_BAGGAGE_KEYS = [CORRELATION_ID_ATTRIBUTE, SESSION_ID_ATTRIBUTE];

/**
 * Copies the Correlation ID and Session ID from OTel baggage onto every log record. The platform
 * rejects log records that belong to a trace but have no Correlation ID, so register this
 * processor before the exporting processor.
 */
export class TelemetryIdsLogRecordProcessor implements LogRecordProcessor {
  onEmit(logRecord: ReadWriteLogRecord, context?: Context): void {
    if (context === undefined) return;
    const baggage = propagation.getBaggage(context);
    for (const baggageKey of COPIED_BAGGAGE_KEYS) {
      const baggageValue = baggage?.getEntry(baggageKey)?.value;
      if (baggageValue) {
        logRecord.setAttribute(baggageKey, baggageValue);
      }
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
