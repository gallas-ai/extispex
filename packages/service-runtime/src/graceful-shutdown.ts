import type { StructuredLogger } from "./structured-logger.ts";

/** Runs `shutdown` once when the process receives SIGINT or SIGTERM, then exits. */
export function runOnTerminationSignal(
  logger: StructuredLogger,
  shutdown: () => Promise<void>,
): void {
  let isShuttingDown = false;
  const handleSignal = async (signalName: Deno.Signal) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    logger.info("Shutting down", { signal: signalName });
    try {
      await shutdown();
      Deno.exit(0);
    } catch (error) {
      logger.error("Shutdown failed", { error });
      Deno.exit(1);
    }
  };
  const terminationSignals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT"]
    : ["SIGINT", "SIGTERM"];
  for (const signalName of terminationSignals) {
    Deno.addSignalListener(signalName, () => handleSignal(signalName));
  }
}
