import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  compareWithPreviousRun,
  formatComparison,
  type Measurement,
  parsePerformanceResults,
  type PerformanceResults,
} from "./performance-results.ts";

function createRun(measurements: Measurement[], injectedDelayMilliseconds = 0): PerformanceResults {
  return {
    formatVersion: 1,
    recordedAt: "2026-11-11T02:00:00.000Z",
    commit: "abc123",
    deployment: "services",
    injectedDelayMilliseconds,
    measurements,
  };
}

const spanIngestion = (value: number): Measurement => ({
  id: "span-ingestion",
  description: "Span ingestion",
  kind: "throughput",
  unit: "spans/s",
  value,
});
const listTracesLatency = (value: number): Measurement => ({
  id: "list-traces-p95",
  description: "List traces, p95",
  kind: "latency",
  unit: "ms",
  value,
});

Deno.test("the first run has nothing to compare with and only records", () => {
  const runComparison = compareWithPreviousRun(
    null,
    createRun([spanIngestion(1_000), listTracesLatency(20)]),
  );
  assertEquals(runComparison.hasPreviousRun, false);
  assertEquals(runComparison.regressionCount, 0);
  assertEquals(runComparison.comparisons.map((comparison) => comparison.change), [null, null]);
  assertStringIncludes(formatComparison(runComparison), "only records");
});

Deno.test("throughput regresses only when it falls by more than 25%", () => {
  const previousRun = createRun([spanIngestion(1_000)]);
  const regressedAt = (currentValue: number) =>
    compareWithPreviousRun(previousRun, createRun([spanIngestion(currentValue)]))
      .comparisons[0].regressed;
  assertEquals(regressedAt(750), false);
  assertEquals(regressedAt(749), true);
  assertEquals(regressedAt(3_000), false);
});

Deno.test("p95 latency regresses only when it rises by more than 25%", () => {
  const previousRun = createRun([listTracesLatency(20)]);
  const regressedAt = (currentValue: number) =>
    compareWithPreviousRun(previousRun, createRun([listTracesLatency(currentValue)]))
      .comparisons[0].regressed;
  assertEquals(regressedAt(25), false);
  assertEquals(regressedAt(25.1), true);
  assertEquals(regressedAt(5), false);
});

Deno.test("a run with a deliberate slowdown fails against a normal run", () => {
  const previousRun = createRun([spanIngestion(5_000), listTracesLatency(12)]);
  const slowedRun = createRun([spanIngestion(2_100), listTracesLatency(63)], 50);
  const runComparison = compareWithPreviousRun(previousRun, slowedRun);
  assertEquals(runComparison.regressionCount, 2);
  const report = formatComparison(runComparison);
  assertStringIncludes(
    report,
    "| Span ingestion (spans/s) | 5,000 | 2,100 | -58.0% | **regressed** |",
  );
  assertStringIncludes(report, "| List traces, p95 (ms) | 12 | 63 | +425.0% | **regressed** |");
  assertStringIncludes(report, "2 measurement(s) are more than 25% worse");
});

Deno.test("a new measurement is recorded without failing the run", () => {
  const runComparison = compareWithPreviousRun(
    createRun([spanIngestion(1_000)]),
    createRun([spanIngestion(990), listTracesLatency(20)]),
  );
  assertEquals(runComparison.regressionCount, 0);
  assertEquals(runComparison.comparisons[1].previousValue, null);
  assertStringIncludes(formatComparison(runComparison), "No measurement is more than 25% worse");
});

Deno.test("results files of another format are refused", () => {
  const run = createRun([spanIngestion(1_000)]);
  assertEquals(parsePerformanceResults(JSON.stringify(run)), run);
  assertThrows(() => parsePerformanceResults(JSON.stringify({ formatVersion: 2 })), Error);
});
