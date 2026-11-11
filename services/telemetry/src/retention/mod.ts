/** Public entry point of the retention module: the only file other modules import. */
export {
  createTelemetryDataLifecycle,
  type TelemetryDataLifecycleOutcome,
} from "./telemetry-data-lifecycle.ts";
