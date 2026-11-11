import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildReportContent,
  formatDuration,
  renderEmailReport,
  renderTeamsMessage,
} from "../src/reports/report-content.ts";
import type { ReportFacts } from "../src/storage/report-delivery-repository.ts";

function facts(overrides: Partial<ReportFacts> = {}): ReportFacts {
  return {
    runId: "run-1",
    projectId: "project-1",
    datasetName: "support-bot",
    executionMode: "server",
    targetName: "staging",
    verdict: "failed",
    createdAt: new Date("2026-11-11T10:00:00Z"),
    finishedAt: new Date("2026-11-11T10:04:12Z"),
    testCaseCounts: { passed: 3, failed: 12, error: 1 },
    unsuccessfulTestCases: Array.from({ length: 10 }, (_, index) => ({
      name: `case-${index + 1}`,
      outcome: "failed" as const,
      passedIterations: 1,
      totalIterations: 3,
    })),
    llmSummary: null,
    ...overrides,
  };
}

Deno.test("formats durations from seconds to hours", () => {
  assertEquals(formatDuration(42_400), "42 s");
  assertEquals(formatDuration(252_000), "4 min 12 s");
  assertEquals(formatDuration(7_500_000), "2 h 5 min");
});

Deno.test("lists ten Test Cases that did not pass and counts the rest", () => {
  const email = renderEmailReport(buildReportContent(facts(), "https://extispex.example"));
  assertStringIncludes(email.text, "Test Cases: 3 passed, 12 failed, 1 ended with an Error, of 16");
  assertStringIncludes(email.text, "Target: staging");
  assertStringIncludes(email.text, "Duration: 4 min 12 s");
  assertStringIncludes(email.text, "- case-10: failed, 1 of 3 Iterations passed");
  assertStringIncludes(email.text, "- and 3 more");
  assertStringIncludes(
    email.text,
    "https://extispex.example/evaluation-runs/run-1?project=project-1&testCase=case-1",
  );
});

Deno.test("carries the LLM Summary when the run has one", () => {
  const content = buildReportContent(
    facts({ llmSummary: "Refund answers regressed.\nTool calls are fine." }),
    null,
  );
  const email = renderEmailReport(content);
  assertStringIncludes(email.text, "LLM Summary:\nRefund answers regressed.");
  assertStringIncludes(email.html, "Refund answers regressed.");
  assertStringIncludes(JSON.stringify(renderTeamsMessage(content)), "Refund answers regressed");
});

Deno.test("leaves links out without the UI's address and escapes names", () => {
  const content = buildReportContent(
    facts({
      datasetName: "<script>alert(1)</script>",
      unsuccessfulTestCases: [{
        name: "a_[b]*c",
        outcome: "error",
        passedIterations: 0,
        totalIterations: 1,
      }],
      testCaseCounts: { passed: 0, failed: 0, error: 1 },
      verdict: "error",
      targetName: null,
    }),
    null,
  );
  const email = renderEmailReport(content);
  assert(!email.html.includes("<script>"));
  assert(!email.html.includes("href"));
  assert(!email.text.includes("http"));
  assertStringIncludes(email.text, "- a_[b]*c: ended with an Error");
  assertStringIncludes(email.subject, "Evaluation Run ended with Errors");
  const teamsMessage = renderTeamsMessage(content) as {
    attachments: { content: { actions: unknown[]; body: unknown[] } }[];
  };
  assertEquals(teamsMessage.attachments[0].content.actions, []);
  assertStringIncludes(
    JSON.stringify(teamsMessage.attachments[0].content.body),
    "a\\\\_\\\\[b\\\\]\\\\*c",
  );
});
