import type { Verdict } from "@extispex/contracts";
import type { ReportFacts } from "../storage/mod.ts";

/** What every channel says about a finished run, before it is put into the channel's format. */
export interface ReportContent {
  title: string;
  verdict: Verdict;
  facts: { label: string; value: string }[];
  unsuccessfulTestCases: {
    name: string;
    outcome: "failed" | "error";
    description: string;
    /** Null when no `PUBLIC_UI_URL` is configured. */
    url: string | null;
  }[];
  /** How many Test Cases did not pass beyond the ones listed. */
  unlistedUnsuccessfulCount: number;
  llmSummary: string | null;
  runUrl: string | null;
}

export interface EmailReport {
  subject: string;
  text: string;
  html: string;
}

const VERDICT_WORDS: Record<Verdict, string> = {
  passed: "passed",
  failed: "failed",
  error: "ended with Errors",
};

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min ${totalSeconds % 60} s`;
  return `${Math.floor(totalMinutes / 60)} h ${totalMinutes % 60} min`;
}

function describeTestCaseCounts(counts: Record<Verdict, number>): string {
  const total = counts.passed + counts.failed + counts.error;
  const parts = [`${counts.passed} passed`, `${counts.failed} failed`];
  if (counts.error > 0) parts.push(`${counts.error} ended with an Error`);
  return `${parts.join(", ")}, of ${total}`;
}

/**
 * The run's facts in words, with links into the UI when its address is known. A link names the
 * Project, so that it opens the right one whichever Project the browser showed last.
 */
export function buildReportContent(facts: ReportFacts, publicUiUrl: string | null): ReportContent {
  const runUrl = publicUiUrl === null ? null : (() => {
    const url = new URL(`evaluation-runs/${encodeURIComponent(facts.runId)}`, `${publicUiUrl}/`);
    url.searchParams.set("project", facts.projectId);
    return url;
  })();
  const testCaseUrl = (testCaseName: string) => {
    if (runUrl === null) return null;
    const url = new URL(runUrl);
    url.searchParams.set("testCase", testCaseName);
    return url.href;
  };
  const counts = facts.testCaseCounts;
  return {
    title: `Evaluation Run ${VERDICT_WORDS[facts.verdict]}: ${facts.datasetName}`,
    verdict: facts.verdict,
    facts: [
      {
        label: "Result",
        value: facts.verdict === "passed"
          ? "Passed"
          : facts.verdict === "failed"
          ? "Failed"
          : "Error",
      },
      { label: "Test Cases", value: describeTestCaseCounts(counts) },
      { label: "Dataset", value: facts.datasetName },
      {
        label: "Target",
        value: facts.targetName ?? "None, run by a script (Client-Driven Execution)",
      },
      {
        label: "Duration",
        value: formatDuration(facts.finishedAt.getTime() - facts.createdAt.getTime()),
      },
    ],
    unsuccessfulTestCases: facts.unsuccessfulTestCases.map((testCase) => ({
      name: testCase.name,
      outcome: testCase.outcome,
      description: testCase.outcome === "error"
        ? "ended with an Error"
        : `failed, ${testCase.passedIterations} of ${testCase.totalIterations} Iterations passed`,
      url: testCaseUrl(testCase.name),
    })),
    unlistedUnsuccessfulCount: counts.failed + counts.error - facts.unsuccessfulTestCases.length,
    llmSummary: facts.llmSummary,
    runUrl: runUrl?.href ?? null,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const VERDICT_COLORS: Record<Verdict, string> = {
  passed: "#1a7f37",
  failed: "#cf222e",
  error: "#9a6700",
};

/** An email with the same content as HTML and as plain text, for clients that show only text. */
export function renderEmailReport(content: ReportContent): EmailReport {
  const textLines = [content.title, ""];
  for (const fact of content.facts) textLines.push(`${fact.label}: ${fact.value}`);
  if (content.unsuccessfulTestCases.length > 0) {
    textLines.push("", "Test Cases that did not pass:");
    for (const testCase of content.unsuccessfulTestCases) {
      textLines.push(
        `- ${testCase.name}: ${testCase.description}${
          testCase.url === null ? "" : `\n  ${testCase.url}`
        }`,
      );
    }
    if (content.unlistedUnsuccessfulCount > 0) {
      textLines.push(`- and ${content.unlistedUnsuccessfulCount} more`);
    }
  }
  if (content.llmSummary !== null) textLines.push("", "LLM Summary:", content.llmSummary);
  if (content.runUrl !== null) textLines.push("", `Open the run: ${content.runUrl}`);

  const link = (url: string | null, label: string) =>
    url === null ? escapeHtml(label) : `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  const htmlParts = [
    `<!doctype html><html><body style="font-family:Segoe UI,Helvetica,Arial,sans-serif;` +
    `color:#1f2328;line-height:1.5;margin:0;padding:16px">`,
    `<h1 style="font-size:18px;margin:0 0 12px;color:${VERDICT_COLORS[content.verdict]}">` +
    `${escapeHtml(content.title)}</h1>`,
    `<table style="border-collapse:collapse;margin:0 0 16px">`,
    ...content.facts.map((fact) =>
      `<tr><th style="text-align:left;padding:2px 16px 2px 0;font-weight:600;vertical-align:top">` +
      `${escapeHtml(fact.label)}</th><td style="padding:2px 0">${escapeHtml(fact.value)}</td></tr>`
    ),
    `</table>`,
  ];
  if (content.unsuccessfulTestCases.length > 0) {
    htmlParts.push(
      `<h2 style="font-size:15px;margin:0 0 8px">Test Cases that did not pass</h2><ul style="margin:0 0 16px;padding-left:20px">`,
      ...content.unsuccessfulTestCases.map((testCase) =>
        `<li>${link(testCase.url, testCase.name)}: ${escapeHtml(testCase.description)}</li>`
      ),
      content.unlistedUnsuccessfulCount > 0
        ? `<li>and ${content.unlistedUnsuccessfulCount} more</li>`
        : "",
      `</ul>`,
    );
  }
  if (content.llmSummary !== null) {
    htmlParts.push(
      `<h2 style="font-size:15px;margin:0 0 8px">LLM Summary</h2>`,
      `<p style="margin:0 0 16px;white-space:pre-wrap">${escapeHtml(content.llmSummary)}</p>`,
    );
  }
  if (content.runUrl !== null) {
    htmlParts.push(
      `<p style="margin:0"><a href="${escapeHtml(content.runUrl)}" style="display:inline-block;` +
        `padding:8px 14px;background:#0969da;color:#ffffff;text-decoration:none;border-radius:6px">` +
        `Open run</a></p>`,
    );
  }
  htmlParts.push(`</body></html>`);
  return {
    subject: `[Extispex] ${content.title}`,
    text: textLines.join("\n"),
    html: htmlParts.join(""),
  };
}

/** Text in an Adaptive Card is Markdown; these characters would otherwise format it. */
function escapeCardMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, "\\$1");
}

/**
 * The message a Teams Workflows webhook expects: an Adaptive Card as an attachment, with an
 * "Open run" button when the UI's address is known.
 */
export function renderTeamsMessage(content: ReportContent): unknown {
  const body: unknown[] = [
    {
      type: "TextBlock",
      text: content.title,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
      color: content.verdict === "passed"
        ? "Good"
        : content.verdict === "failed"
        ? "Attention"
        : "Warning",
    },
    {
      type: "FactSet",
      facts: content.facts.map((fact) => ({ title: fact.label, value: fact.value })),
    },
  ];
  if (content.unsuccessfulTestCases.length > 0) {
    const lines = content.unsuccessfulTestCases.map((testCase) => {
      const name = escapeCardMarkdown(testCase.name);
      return `- ${testCase.url === null ? name : `[${name}](${testCase.url})`}: ` +
        escapeCardMarkdown(testCase.description);
    });
    if (content.unlistedUnsuccessfulCount > 0) {
      lines.push(`- and ${content.unlistedUnsuccessfulCount} more`);
    }
    body.push(
      { type: "TextBlock", text: "Test Cases that did not pass", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: lines.join("\n"), wrap: true },
    );
  }
  if (content.llmSummary !== null) {
    body.push(
      { type: "TextBlock", text: "LLM Summary", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: escapeCardMarkdown(content.llmSummary), wrap: true },
    );
  }
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body,
        actions: content.runUrl === null
          ? []
          : [{ type: "Action.OpenUrl", title: "Open run", url: content.runUrl }],
      },
    }],
  };
}
