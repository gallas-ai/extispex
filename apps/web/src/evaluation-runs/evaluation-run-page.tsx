import type {
  EvaluationRunSummary,
  EvaluatorResult,
  IterationAttempt,
  IterationResult,
  LlmSummary,
  ReportChannel,
  ReportDelivery,
  TestCaseResult,
  TranscriptStep,
} from "@extispex/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import {
  getEvaluationRun,
  getTestCaseResult,
  listIterationResults,
  listReportDeliveries,
  listTestCaseResults,
} from "../api/evaluation-api.ts";
import { serializeTracesUrlState } from "../navigation/traces-url-state.ts";
import { Breadcrumbs } from "../prompts/prompt-parts.tsx";
import { REPORT_SETTINGS_PATH } from "../reports/report-settings-page.tsx";
import { useAccess } from "../sign-in/access-context.ts";
import { AlertIcon, SparklesIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { usePagedResource } from "../ui/use-paged-resource.ts";
import { usePollingWhile } from "../ui/use-polling-while.ts";
import { findExpiredRetentionDays } from "./trace-availability.ts";
import { VerdictBadge } from "./verdict-badge.tsx";

interface EvaluationRunPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function EvaluationRunPage({ credentials, onSignInRequired }: EvaluationRunPageProps) {
  const runId = useParams().runId as string;
  const linkedTestCaseName = useSearchParams()[0].get("testCase");
  const loadRun = useCallback(() => getEvaluationRun(credentials, runId), [credentials, runId]);
  const [runState, reloadRun] = useApiResource(loadRun);
  // The LLM Summary is written after the run finishes, so the page keeps asking until it is there.
  usePollingWhile(
    runState.status === "loaded" &&
      (runState.resource.status === "running" ||
        runState.resource.llmSummary?.status === "pending"),
    reloadRun,
  );
  const breadcrumbs = (title: string) => (
    <Breadcrumbs
      items={[{ label: "Evaluation Runs", path: "/evaluation-runs" }, { label: title }]}
    />
  );

  if (runState.status !== "loaded") {
    return (
      <div className="page page-constrained">
        {breadcrumbs("Run")}
        <div className="page-header">
          <div className="page-heading">
            <h1>Evaluation Run</h1>
          </div>
        </div>
        <section className="panel">
          {runState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
          {runState.status === "failed" && (
            <LoadError
              subject="The Evaluation Run"
              message={runState.message}
              isSignInRequired={runState.isSignInRequired}
              onRetry={reloadRun}
              onSignInRequired={onSignInRequired}
            />
          )}
        </section>
      </div>
    );
  }

  const run = runState.resource;
  const refreshKey = `${run.status}:${run.completedIterations}`;
  return (
    <div className="page page-constrained">
      {breadcrumbs(run.datasetName)}
      <div className="page-header">
        <div className="page-heading">
          <h1 className="prompt-title">{run.datasetName}</h1>
          <p className="page-subtitle">
            Started {new Date(run.createdAt).toLocaleString()} ·{" "}
            {run.targetName === null ? "run by a script" : `calls the Target ${run.targetName}`}
            {" · "}
            {run.completedIterations} of {run.totalIterations} Iterations done
          </p>
        </div>
        <div className="page-actions run-verdict">
          <VerdictBadge status={run.verdict} />
        </div>
      </div>
      {linkedTestCaseName !== null && (
        <LinkedTestCase
          credentials={credentials}
          runId={run.id}
          refreshKey={refreshKey}
          testCaseName={linkedTestCaseName}
        />
      )}
      {run.llmSummary !== null && <LlmSummaryPanel summary={run.llmSummary} />}
      <ReportDeliveries credentials={credentials} run={run} />
      <TestCaseResults credentials={credentials} runId={run.id} refreshKey={refreshKey} />
    </div>
  );
}

const CHANNEL_LABELS: Record<ReportChannel, string> = { email: "Email", teams: "Teams" };

function describeDelivery(delivery: ReportDelivery): string {
  const formatTime = (isoTime: string) => new Date(isoTime).toLocaleString();
  switch (delivery.status) {
    case "delivered":
      return `Delivered ${formatTime(delivery.deliveredAt!)}` +
        (delivery.attempts > 1 ? ` on attempt ${delivery.attempts}.` : ".");
    case "sending":
      return `Sending, attempt ${delivery.attempts}.`;
    case "failed":
      return `Gave up after ${delivery.attempts} attempts: ${delivery.lastError}`;
    case "pending":
      return delivery.nextAttemptAt === null
        ? "Waiting to be sent."
        : `Attempt ${delivery.attempts} failed, trying again ${
          formatTime(delivery.nextAttemptAt)
        }: ${delivery.lastError}`;
  }
}

/** Where the run's Report went. A delivery never changes the run's result. */
function ReportDeliveries(
  { credentials, run }: { credentials: ApiCredentials; run: EvaluationRunSummary },
) {
  const loadDeliveries = useCallback(
    () => listReportDeliveries(credentials, run.id),
    // A run gets its deliveries when it finishes.
    [credentials, run.id, run.status],
  );
  const [deliveriesState, reloadDeliveries] = useApiResource(loadDeliveries);
  const deliveries = deliveriesState.status === "loaded"
    ? deliveriesState.resource.reportDeliveries
    : [];
  usePollingWhile(
    deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "sending"),
    reloadDeliveries,
  );
  return (
    <section className="panel report-deliveries" aria-label="Reports">
      <header className="report-deliveries-header">
        <h2 className="panel-title">Reports</h2>
        <Link className="report-deliveries-settings" to={REPORT_SETTINGS_PATH}>
          Report settings
        </Link>
      </header>
      {deliveriesState.status === "failed" && (
        <p className="status-text report-deliveries-note" role="alert">
          {deliveriesState.message}
        </p>
      )}
      {deliveriesState.status === "loaded" && deliveries.length === 0 && (
        <p className="status-text report-deliveries-note">
          {run.status === "running"
            ? "Reports go out when the run finishes."
            : "No Report was sent for this run."}
        </p>
      )}
      {deliveries.length > 0 && (
        <ul className="report-delivery-list">
          {deliveries.map((delivery) => (
            <li key={delivery.channel} className="report-delivery">
              <span className="report-delivery-channel">{CHANNEL_LABELS[delivery.channel]}</span>
              <span
                className={`status-badge ${
                  delivery.status === "delivered"
                    ? "status-badge-ok"
                    : delivery.status === "failed"
                    ? "status-badge-error"
                    : "status-badge-unset"
                }`}
              >
                {delivery.status === "delivered"
                  ? "Delivered"
                  : delivery.status === "failed"
                  ? "Failed"
                  : delivery.status === "sending"
                  ? "Sending"
                  : "Pending"}
              </span>
              <span className="status-text report-delivery-detail">
                {describeDelivery(delivery)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Test Case a Report linked to, opened above the others whichever page it is on. */
function LinkedTestCase(
  { credentials, runId, refreshKey, testCaseName }: ResultsProps & { testCaseName: string },
) {
  const loadTestCase = useCallback(
    () => getTestCaseResult(credentials, runId, testCaseName),
    [credentials, runId, testCaseName],
  );
  const [testCaseState, reloadTestCase] = useApiResource(loadTestCase);
  const panelRef = useRef<HTMLDivElement>(null);
  const isLoaded = testCaseState.status === "loaded";
  useEffect(() => {
    if (isLoaded) panelRef.current?.scrollIntoView({ block: "start" });
  }, [isLoaded]);
  if (testCaseState.status === "loading") return null;
  if (testCaseState.status === "failed") {
    return <PageProblem message={testCaseState.message} onRetry={reloadTestCase} />;
  }
  return (
    <div className="linked-test-case" ref={panelRef}>
      <TestCaseResultPanel
        credentials={credentials}
        runId={runId}
        refreshKey={refreshKey}
        testCase={testCaseState.resource}
        isInitiallyOpen
      />
    </div>
  );
}

/** The LLM-written overview of the finished run. It never changes the verdict. */
function LlmSummaryPanel({ summary }: { summary: LlmSummary }) {
  return (
    <section className="panel panel-form llm-summary" aria-label="LLM Summary">
      <h2 className="section-title">
        <SparklesIcon size={14} /> LLM Summary
      </h2>
      {summary.status === "pending" && (
        <p className="status-text" role="status">
          {summary.providerName} is writing the LLM Summary…
        </p>
      )}
      {summary.status === "completed" && <p className="llm-summary-text">{summary.text}</p>}
      {summary.status === "failed" && (
        <p className="attempt-error" role="note">
          The LLM Summary could not be written: {summary.error}
        </p>
      )}
      {summary.status === "not_configured" && (
        <p className="status-text">
          No LLM Summary: the Project had no summary provider when this run finished. Choose one
          under <Link to="/llm-providers">LLM providers</Link>.
        </p>
      )}
      {summary.status === "completed" && (
        <p className="status-text">
          Written by {summary.model} through {summary.providerName}, with {summary.prompt === null
            ? "the default prompt"
            : `${summary.prompt.name} version ${summary.prompt.version}`}.
        </p>
      )}
    </section>
  );
}

interface ResultsProps {
  credentials: ApiCredentials;
  runId: string;
  /** Changes when the run's results may have changed. */
  refreshKey: string;
}

function TestCaseResults({ credentials, runId, refreshKey }: ResultsProps) {
  const loadPage = useCallback(async (cursor: number | null) => {
    const page = await listTestCaseResults(credentials, runId, cursor);
    return { items: page.testCases, nextCursor: page.nextCursor };
  }, [credentials, runId]);
  const { state, loadMore, retry } = usePagedResource(loadPage, refreshKey);

  if (state.status === "loading") {
    return (
      <section className="panel">
        <div className="panel-loading" aria-busy="true" />
      </section>
    );
  }
  if (state.status === "failed") return <PageProblem message={state.message} onRetry={retry} />;
  return (
    <div className="test-case-results">
      {state.items.map((testCase) => (
        <TestCaseResultPanel
          key={testCase.name}
          credentials={credentials}
          runId={runId}
          refreshKey={refreshKey}
          testCase={testCase}
        />
      ))}
      {state.hasMore && (
        <LoadMoreButton
          label="Load more Test Cases"
          isLoading={state.isLoadingMore}
          onClick={loadMore}
        />
      )}
    </div>
  );
}

function PageProblem({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="callout callout-danger" role="alert">
      <AlertIcon size={16} />
      <div>
        <p>{message}</p>
        <button type="button" className="button button-secondary button-small" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

function LoadMoreButton(
  { label, isLoading, onClick }: { label: string; isLoading: boolean; onClick: () => void },
) {
  return (
    <button
      type="button"
      className="button button-secondary load-more-button"
      disabled={isLoading}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function TestCaseResultPanel(
  { credentials, runId, refreshKey, testCase, isInitiallyOpen = false }: ResultsProps & {
    testCase: TestCaseResult;
    isInitiallyOpen?: boolean;
  },
) {
  const [isOpen, setIsOpen] = useState(isInitiallyOpen);
  return (
    <section className="panel test-case-result" aria-label={`Test Case ${testCase.name}`}>
      <header className="test-case-result-header">
        <h2 className="panel-title">{testCase.name}</h2>
        <span className="status-text">
          {testCase.scope === "session" ? `Session of ${testCase.steps?.length ?? 0} steps · ` : ""}
          {testCase.passedIterations} of {testCase.totalIterations} passed · needs{" "}
          {Math.round(testCase.passThreshold * 100)}%
        </span>
        <VerdictBadge status={testCase.outcome} />
        <button
          type="button"
          className="button button-secondary button-small"
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
        >
          {isOpen ? "Hide Iterations" : "Show Iterations"}
        </button>
      </header>
      {isOpen && (
        <IterationResults
          credentials={credentials}
          runId={runId}
          refreshKey={refreshKey}
          testCaseName={testCase.name}
        />
      )}
    </section>
  );
}

function IterationResults(
  { credentials, runId, refreshKey, testCaseName }: ResultsProps & { testCaseName: string },
) {
  const loadPage = useCallback(async (cursor: number | null) => {
    const page = await listIterationResults(credentials, runId, testCaseName, cursor);
    return { items: page.iterations, nextCursor: page.nextCursor };
  }, [credentials, runId, testCaseName]);
  const { state, loadMore, retry } = usePagedResource(loadPage, refreshKey);

  if (state.status === "loading") return <div className="panel-loading" aria-busy="true" />;
  if (state.status === "failed") return <PageProblem message={state.message} onRetry={retry} />;
  return (
    <>
      <ol className="iteration-list">
        {state.items.map((iteration) => (
          <IterationRow key={iteration.iterationId} iteration={iteration} />
        ))}
      </ol>
      {state.hasMore && (
        <LoadMoreButton
          label="Load more Iterations"
          isLoading={state.isLoadingMore}
          onClick={loadMore}
        />
      )}
    </>
  );
}

function IterationRow({ iteration }: { iteration: IterationResult }) {
  return (
    <li className="iteration-row">
      <div className="iteration-row-heading">
        <span className="section-title">Iteration {iteration.iterationNumber}</span>
        <VerdictBadge status={iteration.status} />
      </div>
      {iteration.attempts.map((attempt) => (
        <AttemptDetails
          key={attempt.attempt}
          attempt={attempt}
          showNumber={iteration.attempts.length > 1}
        />
      ))}
    </li>
  );
}

/** Results keep their own copy of what they show, so only the links to traces go. */
function useExpiredRetentionDays(reportedAt: string): number | null {
  const retentionDays = useAccess().selectedProject?.retentionDays;
  return findExpiredRetentionDays(reportedAt, retentionDays, Date.now());
}

/** A link to the Correlation ID's traces, or why they are gone. */
function TracesLink(
  { correlationId, expiredRetentionDays }: {
    correlationId: string;
    expiredRetentionDays: number | null;
  },
) {
  if (expiredRetentionDays === null) {
    return <Link to={tracesPath(correlationId)}>View traces</Link>;
  }
  return (
    <span className="trace-unavailable" role="note">
      Trace no longer available: the Project keeps telemetry for {expiredRetentionDays} days.
    </span>
  );
}

function AttemptDetails(
  { attempt, showNumber }: { attempt: IterationAttempt; showNumber: boolean },
) {
  const expiredRetentionDays = useExpiredRetentionDays(attempt.reportedAt);
  return (
    <div className="attempt-details">
      {showNumber && <p className="status-text">Attempt {attempt.attempt}</p>}
      {attempt.correlationId !== null && (
        <p className="status-text">
          Correlation ID <code className="cell-breaks-anywhere">{attempt.correlationId}</code>{" "}
          <TracesLink
            correlationId={attempt.correlationId}
            expiredRetentionDays={expiredRetentionDays}
          />
        </p>
      )}
      {attempt.transcript !== null
        ? <Transcript steps={attempt.transcript} expiredRetentionDays={expiredRetentionDays} />
        : attempt.output !== null && <pre className="attempt-output">{attempt.output}</pre>}
      {attempt.error !== null && <p className="attempt-error" role="note">{attempt.error}</p>}
      {attempt.evaluatorResults.length > 0 && (
        <ul className="evaluator-results">
          {attempt.evaluatorResults.map((result) => (
            <li key={result.name} className="evaluator-result">
              <VerdictBadge status={result.outcome} />
              <span className="evaluator-result-name">{result.name}</span>
              {typeof result.score === "number" && (
                <span className="text-muted evaluator-result-score">
                  score {result.score.toFixed(2)}
                </span>
              )}
              <span className="text-muted evaluator-result-reason">{result.reason}</span>
              {result.model !== undefined && (
                <span className="text-muted evaluator-result-model">
                  {result.prompt === undefined
                    ? result.model
                    : `${result.model} · ${result.prompt.name} version ${result.prompt.version}`}
                </span>
              )}
              <MatchedSpans
                result={result}
                correlationId={attempt.correlationId}
                isTraceExpired={expiredRetentionDays !== null}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatStepInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

/** What was sent at each step of a Session, and what the application answered. */
function Transcript(
  { steps, expiredRetentionDays }: {
    steps: TranscriptStep[];
    expiredRetentionDays: number | null;
  },
) {
  if (steps.length === 0) return <p className="status-text">No step was answered.</p>;
  return (
    <ol className="transcript" aria-label="Transcript">
      {steps.map((step) => (
        <li key={step.stepNumber} className="transcript-step">
          <p className="transcript-input">
            <span className="transcript-label">Step {step.stepNumber}</span>
            <span className="cell-breaks-anywhere">{formatStepInput(step.input)}</span>
          </p>
          <pre className="attempt-output">{step.output}</pre>
          <p className="status-text">
            Correlation ID <code className="cell-breaks-anywhere">{step.correlationId}</code>{" "}
            <TracesLink
              correlationId={step.correlationId}
              expiredRetentionDays={expiredRetentionDays}
            />
          </p>
        </li>
      ))}
    </ol>
  );
}

function tracesPath(correlationId: string, traceId?: string, spanId?: string): string {
  const query = serializeTracesUrlState({
    correlationId,
    sessionId: "",
    traceId: traceId ?? null,
    spanId: spanId ?? null,
  });
  return `/traces${query}`;
}

/** The spans a Telemetry Evaluator counted, from the result's own copy of them. */
function MatchedSpans(
  { result, correlationId, isTraceExpired }: {
    result: EvaluatorResult;
    correlationId: string | null;
    isTraceExpired: boolean;
  },
) {
  const { matchedSpans = [], matchedSpanCount = 0 } = result;
  if (matchedSpans.length === 0) return null;
  return (
    <div className="matched-spans">
      <ul className="matched-span-list">
        {matchedSpans.map((span) => (
          <li key={`${span.traceId}:${span.spanId}`} className="matched-span">
            {isTraceExpired
              ? <span>{span.name}</span>
              : (
                <Link to={tracesPath(correlationId ?? "", span.traceId, span.spanId)}>
                  {span.name}
                </Link>
              )}
            {span.serviceName !== null && <span className="text-muted">{span.serviceName}</span>}
            <span className="text-muted">{span.durationMilliseconds.toFixed(1)} ms</span>
          </li>
        ))}
      </ul>
      {matchedSpanCount > matchedSpans.length && (
        <p className="status-text">
          Showing {matchedSpans.length} of {matchedSpanCount} matching spans.
        </p>
      )}
    </div>
  );
}
