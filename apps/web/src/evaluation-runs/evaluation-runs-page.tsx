import type { EvaluationRunSummary } from "@extispex/contracts";
import { useCallback } from "react";
import { Link } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import { listEvaluationRuns } from "../api/evaluation-api.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { RunIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { useNow } from "../ui/use-now.ts";
import { usePollingWhile } from "../ui/use-polling-while.ts";
import { VerdictBadge } from "./verdict-badge.tsx";

interface EvaluationRunsPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function evaluationRunPagePath(runId: string): string {
  return `/evaluation-runs/${encodeURIComponent(runId)}`;
}

export function EvaluationRunsPage({ credentials, onSignInRequired }: EvaluationRunsPageProps) {
  const loadRuns = useCallback(() => listEvaluationRuns(credentials), [credentials]);
  const [runsState, reloadRuns] = useApiResource(loadRuns);
  usePollingWhile(
    runsState.status === "loaded" &&
      runsState.resource.evaluationRuns.some((run) => run.status === "running"),
    reloadRuns,
  );

  return (
    <div className="page page-constrained">
      <div className="page-header">
        <div className="page-heading">
          <h1>Evaluation Runs</h1>
          <p className="page-subtitle">Executions of a Dataset, newest first.</p>
        </div>
      </div>
      <section className="panel" aria-label="Evaluation Run list">
        {runsState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
        {runsState.status === "failed" && (
          <LoadError
            subject="Evaluation Runs"
            message={runsState.message}
            isSignInRequired={runsState.isSignInRequired}
            onRetry={reloadRuns}
            onSignInRequired={onSignInRequired}
          />
        )}
        {runsState.status === "loaded" && runsState.resource.evaluationRuns.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <RunIcon size={22} />
            </span>
            <h2>No Evaluation Runs yet</h2>
            <p>
              A script starts a run with <code>POST /v1/evaluation-runs</code>. See{" "}
              <code>examples/</code> in the repository.
            </p>
          </div>
        )}
        {runsState.status === "loaded" && runsState.resource.evaluationRuns.length > 0 && (
          <RunTable runs={runsState.resource.evaluationRuns} />
        )}
      </section>
    </div>
  );
}

function RunTable({ runs }: { runs: EvaluationRunSummary[] }) {
  const nowUnixMilliseconds = useNow(15_000);
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Dataset</th>
            <th scope="col">Verdict</th>
            <th scope="col" className="column-numeric">Iterations</th>
            <th scope="col" className="column-numeric">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="evaluation-run-row">
              <td className="cell-breaks-anywhere">
                <Link to={evaluationRunPagePath(run.id)}>{run.datasetName}</Link>
              </td>
              <td>
                <VerdictBadge status={run.verdict} />
              </td>
              <td className="column-numeric">{run.completedIterations} / {run.totalIterations}</td>
              <td
                className="column-numeric text-muted"
                title={new Date(run.createdAt).toLocaleString()}
              >
                {formatRelativeTime(Date.parse(run.createdAt), nowUnixMilliseconds)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
