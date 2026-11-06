import { type Context, propagation } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";
import { CORRELATION_ID_ATTRIBUTE, SESSION_ID_ATTRIBUTE } from "./telemetry-id-attributes.ts";

const COPIED_BAGGAGE_KEYS = [CORRELATION_ID_ATTRIBUTE, SESSION_ID_ATTRIBUTE];

/**
 * Copies the Correlation ID and Session ID from OTel baggage onto every span when it starts.
 * The platform rejects spans without a Correlation ID, so register this processor before the
 * exporting processor.
 */
export class TelemetryIdsSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const baggage = propagation.getBaggage(parentContext);
    for (const baggageKey of COPIED_BAGGAGE_KEYS) {
      const baggageValue = baggage?.getEntry(baggageKey)?.value;
      if (baggageValue) {
        span.setAttribute(baggageKey, baggageValue);
      }
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
