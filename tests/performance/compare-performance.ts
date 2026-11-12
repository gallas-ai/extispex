/**
 * Compares a run's results with the previous run's commit and exits with 1 on a regression:
 *
 *     deno task compare:performance <previous results file> <current results file>
 *
 * A missing previous file means there is no previous run: the current run only records. The report
 * goes to the log and, in GitHub Actions, to the job summary.
 */
import {
  compareWithPreviousRun,
  formatComparison,
  parsePerformanceResults,
} from "./performance-results.ts";

const [previousFile, currentFile] = Deno.args;
if (!previousFile || !currentFile) {
  console.error("Usage: compare-performance.ts <previous results file> <current results file>");
  Deno.exit(2);
}

async function readResultsIfPresent(resultsFile: string) {
  try {
    return parsePerformanceResults(await Deno.readTextFile(resultsFile));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

const previousRun = await readResultsIfPresent(previousFile);
const currentRun = await readResultsIfPresent(currentFile);
if (currentRun === null) {
  console.error(`${currentFile} does not exist.`);
  Deno.exit(2);
}
const runComparison = compareWithPreviousRun(previousRun, currentRun);
const delayNote = currentRun.injectedDelayMilliseconds > 0
  ? `This run added a deliberate delay of ${currentRun.injectedDelayMilliseconds} ms before every request.\n\n`
  : "";
const previousNote = previousRun === null
  ? ""
  : `Compared with commit ${
    previousRun.commit ?? "unknown"
  }, measured at ${previousRun.recordedAt}.\n\n`;
const report = `## Nightly performance\n\n${previousNote}${delayNote}${
  formatComparison(runComparison)
}`;
console.log(report);
const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
if (summaryFile) await Deno.writeTextFile(summaryFile, report, { append: true });
Deno.exit(runComparison.regressionCount > 0 ? 1 : 0);
