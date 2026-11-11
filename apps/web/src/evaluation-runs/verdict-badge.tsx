import type { IterationStatus, Verdict } from "@extispex/contracts";

const STATUS_LABELS: Record<IterationStatus, string> = {
  awaiting_report: "Waiting for report",
  executing: "Calling Target",
  evaluating: "Evaluating",
  passed: "Passed",
  failed: "Failed",
  error: "Error",
};

/** A verdict or an Iteration's status. Without a verdict, the thing is still in progress. */
export function VerdictBadge({ status }: { status: Verdict | IterationStatus | null }) {
  if (status === null) {
    return <span className="status-badge status-badge-unset">In progress</span>;
  }
  return <span className={`status-badge verdict-${status}`}>{STATUS_LABELS[status]}</span>;
}
