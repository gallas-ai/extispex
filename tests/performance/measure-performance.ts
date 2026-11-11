/**
 * Measures ingestion throughput, query latency and the evaluation job queue against a deployment
 * and writes the results as JSON:
 *
 *     E2E_POSTGRES_URL=postgresql://... deno task test:performance results.json
 *
 * The deployment comes from `tests/e2e/deployment.ts`, the separate services on PostgreSQL unless
 * `E2E_DEPLOYMENT` says otherwise. Options in the environment:
 *
 * - `PERFORMANCE_INJECTED_DELAY_MILLISECONDS`: a delay before every request, to show that the
 *   comparison catches a slower run. 0 by default.
 * - `PERFORMANCE_SCALE`: multiplies the amount of work, such as 0.2 for a quick local try. Only
 *   runs of the same scale are comparable.
 * - `PERFORMANCE_COMMIT`: the measured commit, recorded in the results.
 */
import { startDeployment } from "@extispex/e2e-tests";
import { measureIngestion } from "./ingestion-load.ts";
import { measureJobQueue } from "./job-queue-load.ts";
import { createLoadClient } from "./load-client.ts";
import type { PerformanceResults } from "./performance-results.ts";
import { measureQueryLatency } from "./query-latency.ts";

const [outputFile] = Deno.args;
if (!outputFile) {
  console.error("Usage: measure-performance.ts <results file>");
  Deno.exit(2);
}
const injectedDelayMilliseconds = Number(
  Deno.env.get("PERFORMANCE_INJECTED_DELAY_MILLISECONDS") || "0",
);
const scale = Number(Deno.env.get("PERFORMANCE_SCALE") || "1");
if (!(injectedDelayMilliseconds >= 0) || !(scale > 0)) {
  console.error(
    "PERFORMANCE_INJECTED_DELAY_MILLISECONDS must be 0 or more, PERFORMANCE_SCALE more than 0.",
  );
  Deno.exit(2);
}
const scaled = (amount: number) => Math.max(1, Math.round(amount * scale));
if (!Deno.env.get("E2E_DEPLOYMENT")) Deno.env.set("E2E_DEPLOYMENT", "services");
const deploymentName = Deno.env.get("E2E_DEPLOYMENT")!;

const loadClient = createLoadClient(injectedDelayMilliseconds);
console.log(`Starting the ${deploymentName} deployment.`);
const deployment = await startDeployment();
try {
  console.log("Measuring ingestion throughput.");
  const ingestion = await measureIngestion(deployment, loadClient, {
    senderCount: 8,
    warmUpRequestsPerSender: 3,
    requestsPerSender: scaled(75),
  });
  console.log("Measuring query latency.");
  const queryMeasurements = await measureQueryLatency(
    deployment,
    loadClient,
    ingestion.ingestedData,
    { warmUpRequests: 10, measuredRequests: scaled(150) },
  );
  console.log("Measuring the evaluation job queue.");
  const jobQueueMeasurements = await measureJobQueue(deployment, loadClient, {
    testCaseCount: 100,
    scriptCount: 4,
    runsPerScript: scaled(3),
  });
  const results: PerformanceResults = {
    formatVersion: 1,
    recordedAt: new Date().toISOString(),
    commit: Deno.env.get("PERFORMANCE_COMMIT") || null,
    deployment: deploymentName,
    injectedDelayMilliseconds,
    measurements: [...ingestion.measurements, ...queryMeasurements, ...jobQueueMeasurements],
  };
  await Deno.writeTextFile(outputFile, `${JSON.stringify(results, null, 2)}\n`);
  for (const measurement of results.measurements) {
    console.log(`${measurement.description}: ${measurement.value} ${measurement.unit}`);
  }
} finally {
  await deployment.stop();
}
