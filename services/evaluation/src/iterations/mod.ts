/** Public entry point of the iterations module: the only file other modules import. */
export { passIterationTelemetryGate } from "./iteration-telemetry-gate.ts";
export { executeIterationAgainstTarget, type ExecutionResult } from "./target-execution.ts";
export { createTelemetryClient, type TelemetryClient } from "./telemetry-client.ts";
export { DEFAULT_TRACE_COMPLETION_TIMING, type TraceCompletionTiming } from "./trace-completion.ts";
