/**
 * The results of one performance run and the comparison with the previous run. A run counts as a
 * regression when a throughput fell or a p95 latency rose by more than the tolerance; see
 * docs/adr/0021-nightly-performance-compared-with-the-previous-run.md.
 */

/** Throughput is better when higher, latency when lower. */
export type MeasurementKind = "throughput" | "latency";

export interface Measurement {
  /** Stable across runs: the comparison matches measurements by it. */
  id: string;
  description: string;
  kind: MeasurementKind;
  /** Such as `spans/s` or `ms`. */
  unit: string;
  value: number;
}

export interface PerformanceResults {
  formatVersion: 1;
  recordedAt: string;
  /** The commit that was measured, when known. */
  commit: string | null;
  deployment: string;
  /** Added before every request to demonstrate a regression; 0 in a normal run. */
  injectedDelayMilliseconds: number;
  measurements: Measurement[];
}

/** More than 25% lower throughput or higher p95 latency than the previous run fails the run. */
export const REGRESSION_TOLERANCE = 0.25;

export interface MeasurementComparison {
  measurement: Measurement;
  /** Null when the previous run did not have this measurement. */
  previousValue: number | null;
  /** `current / previous - 1`, such as -0.3 for 30% less; null without a previous value. */
  change: number | null;
  regressed: boolean;
}

export interface RunComparison {
  hasPreviousRun: boolean;
  comparisons: MeasurementComparison[];
  regressionCount: number;
}

/** Compares each current measurement with the same one of the previous run, if there was one. */
export function compareWithPreviousRun(
  previousRun: PerformanceResults | null,
  currentRun: PerformanceResults,
  tolerance = REGRESSION_TOLERANCE,
): RunComparison {
  const previousValues = new Map(
    (previousRun?.measurements ?? []).map((measurement) => [measurement.id, measurement.value]),
  );
  const comparisons = currentRun.measurements.map((measurement): MeasurementComparison => {
    const previousValue = previousValues.get(measurement.id) ?? null;
    if (previousValue === null || previousValue <= 0) {
      return { measurement, previousValue, change: null, regressed: false };
    }
    const change = measurement.value / previousValue - 1;
    const regressed = measurement.kind === "throughput" ? change < -tolerance : change > tolerance;
    return { measurement, previousValue, change, regressed };
  });
  return {
    hasPreviousRun: previousRun !== null,
    comparisons,
    regressionCount: comparisons.filter((comparison) => comparison.regressed).length,
  };
}

/** A Markdown report of the comparison, for the log and the workflow's job summary. */
export function formatComparison(runComparison: RunComparison, tolerance = REGRESSION_TOLERANCE) {
  const tolerancePercent = Math.round(tolerance * 100);
  const formatValue = (value: number) =>
    value.toLocaleString("en-US", { maximumFractionDigits: value < 100 ? 1 : 0 });
  const lines = [
    "| Measurement | Previous | Current | Change | Result |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const { measurement, previousValue, change, regressed } of runComparison.comparisons) {
    const changeText = change === null
      ? "–"
      : `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
    const resultText = change === null ? "recorded" : regressed ? "**regressed**" : "ok";
    lines.push(
      `| ${measurement.description} (${measurement.unit}) | ${
        previousValue === null ? "–" : formatValue(previousValue)
      } | ${formatValue(measurement.value)} | ${changeText} | ${resultText} |`,
    );
  }
  const verdict = !runComparison.hasPreviousRun
    ? "No previous run on `main` to compare with: this run only records its results."
    : runComparison.regressionCount === 0
    ? `No measurement is more than ${tolerancePercent}% worse than the previous run.`
    : `${runComparison.regressionCount} measurement(s) are more than ${tolerancePercent}% worse than the previous run.`;
  return `${lines.join("\n")}\n\n${verdict}\n`;
}

/** Reads results written by `measure-performance.ts`, refusing a file of another format. */
export function parsePerformanceResults(fileText: string): PerformanceResults {
  const parsed = JSON.parse(fileText) as Partial<PerformanceResults>;
  if (parsed.formatVersion !== 1 || !Array.isArray(parsed.measurements)) {
    throw new Error("Not a performance results file of format version 1.");
  }
  return parsed as PerformanceResults;
}
