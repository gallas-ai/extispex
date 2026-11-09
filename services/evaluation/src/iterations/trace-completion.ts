import type { CorrelationTelemetryResponse } from "@extispex/contracts";

/** How the worker waits for an Iteration's telemetry. */
export interface TraceCompletionTiming {
  /** How often Telemetry is asked. */
  pollIntervalMilliseconds: number;
  /** How long a root span must have been stored before its trace counts as complete. */
  rootSpanSettleMilliseconds: number;
  /** How long after the Output a root span may still arrive. */
  rootSpanTimeoutMilliseconds: number;
}

export const DEFAULT_TRACE_COMPLETION_TIMING: TraceCompletionTiming = {
  pollIntervalMilliseconds: 2_000,
  rootSpanSettleMilliseconds: 10_000,
  rootSpanTimeoutMilliseconds: 60_000,
};

export type TraceCompletion =
  | { status: "complete" }
  | { status: "waiting" }
  | { status: "timed_out"; reason: string };

/**
 * Honeycomb Refinery's root-span rule, adapted for evaluation. Every trace of the Correlation ID
 * needs a root span that has been stored long enough for spans from other services to arrive. A
 * root span that arrives just before the timeout still gets its full settling time.
 */
export function decideTraceCompletion(
  telemetry: CorrelationTelemetryResponse,
  millisecondsSinceOutput: number,
  timing: TraceCompletionTiming,
): TraceCompletion {
  const hasEveryRootSpan = telemetry.traces.length > 0 &&
    telemetry.traces.every((trace) => trace.rootSpanStoredAt !== null);
  if (hasEveryRootSpan) {
    const latestRootStoredAt = Math.max(
      ...telemetry.traces.map((trace) => Date.parse(trace.rootSpanStoredAt as string)),
    );
    const isSettled =
      Date.parse(telemetry.readAt) - latestRootStoredAt >= timing.rootSpanSettleMilliseconds;
    return isSettled ? { status: "complete" } : { status: "waiting" };
  }
  if (millisecondsSinceOutput < timing.rootSpanTimeoutMilliseconds) return { status: "waiting" };
  const seconds = timing.rootSpanTimeoutMilliseconds / 1_000;
  return {
    status: "timed_out",
    reason: telemetry.traces.length === 0
      ? `No telemetry for this Correlation ID arrived within ${seconds} s after the Output.`
      : `No root span arrived within ${seconds} s after the Output.`,
  };
}
