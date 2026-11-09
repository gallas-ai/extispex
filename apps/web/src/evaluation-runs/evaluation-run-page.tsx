import type {
  EvaluatorResult,
  IterationAttempt,
  IterationResult,
  TestCaseResult,
} from "@extispex/contracts";
import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import {
  getEvaluationRun,
  listIterationResults,
  listTestCaseResults,
} from "../api/evaluation-api.ts";
import { serializeTracesUrlState } from "../navigation/traces-url-state.ts";
import { Breadcrumbs } from "../prompts/prompt-parts.tsx";
import { AlertIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { usePagedResource } from "../ui/use-paged-resource.ts";
import { usePollingWhile } from "../ui/use-polling-while.ts";
import { VerdictBadge } from "./verdict-badge.tsx";

interface EvaluationRunPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function EvaluationRunPage({ credentials, onSignInRequired }: EvaluationRunPageProps) {
  const runId = useParams().runId as string;
  const loadRun = useCallback(() => getEvaluationRun(credentials, runId), [credentials, runId]);
  const [runState, reloadRun] = useApiResource(loadRun);
  usePollingWhile(
    runState.status === "loaded" && runState.resource.status === "running",
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
  return (
    <div className="page page-constrained">
      {breadcrumbs(run.datasetName)}
      <div className="page-header">
        <div className="page-heading">
          <h1 className="prompt-title">{run.datasetName}</h1>
          <p className="page-subtitle">
            Started {new Date(run.createdAt).toLocaleString()} · {run.completedIterations} of{" "}
            {run.totalIterations} Iterations done
          </p>
        </div>
        <div className="page-actions run-verdict">
          <VerdictBadge status={run.verdict} />
        </div>
      </div>
      <TestCaseResults
        credentials={credentials}
        runId={run.id}
        refreshKey={`${run.status}:${run.completedIterations}`}
      />
    </div>
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
  { credentials, runId, refreshKey, testCase }: ResultsProps & { testCase: TestCaseResult },
) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <section className="panel test-case-result" aria-label={`Test Case ${testCase.name}`}>
      <header className="test-case-result-header">
        <h2 className="panel-title">{testCase.name}</h2>
        <span className="status-text">
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

function AttemptDetails(
  { attempt, showNumber }: { attempt: IterationAttempt; showNumber: boolean },
) {
  return (
    <div className="attempt-details">
      {showNumber && <p className="status-text">Attempt {attempt.attempt}</p>}
      {attempt.correlationId !== null && (
        <p className="status-text">
          Correlation ID <code className="cell-breaks-anywhere">{attempt.correlationId}</code>{" "}
          <Link to={tracesPath(attempt.correlationId)}>View traces</Link>
        </p>
      )}
      {attempt.output !== null && <pre className="attempt-output">{attempt.output}</pre>}
      {attempt.error !== null && <p className="attempt-error" role="note">{attempt.error}</p>}
      {attempt.evaluatorResults.length > 0 && (
        <ul className="evaluator-results">
          {attempt.evaluatorResults.map((result) => (
            <li key={result.name} className="evaluator-result">
              <VerdictBadge status={result.outcome} />
              <span className="evaluator-result-name">{result.name}</span>
              <span className="text-muted evaluator-result-reason">{result.reason}</span>
              <MatchedSpans result={result} correlationId={attempt.correlationId} />
            </li>
          ))}
        </ul>
      )}
    </div>
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
  { result, correlationId }: { result: EvaluatorResult; correlationId: string | null },
) {
  const { matchedSpans = [], matchedSpanCount = 0 } = result;
  if (matchedSpans.length === 0) return null;
  return (
    <div className="matched-spans">
      <ul className="matched-span-list">
        {matchedSpans.map((span) => (
          <li key={`${span.traceId}:${span.spanId}`} className="matched-span">
            <Link to={tracesPath(correlationId ?? "", span.traceId, span.spanId)}>{span.name}</Link>
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
