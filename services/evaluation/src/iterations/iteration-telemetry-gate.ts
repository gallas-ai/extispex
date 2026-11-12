import type { Span } from "@extispex/contracts";
import { IdentityUnavailableError, UnknownProjectError } from "@extispex/service-runtime";
import type { EvaluateAttemptJob } from "../job-queue/mod.ts";
import type { AttemptToEvaluate, EvaluationRunRepository } from "../storage/mod.ts";
import { type TelemetryClient, TelemetryUnavailableError } from "./telemetry-client.ts";
import { decideTraceCompletion, type TraceCompletionTiming } from "./trace-completion.ts";

export interface IterationTelemetryGateDependencies {
  evaluationRunRepository: EvaluationRunRepository;
  telemetryClient: TelemetryClient;
  timing: TraceCompletionTiming;
  readCurrentTime: () => Date;
}

/** Whether an attempt's spans can be judged yet. */
export type TelemetryGateResult =
  | { status: "ready"; spans: Span[] }
  | { status: "waiting" }
  | { status: "error"; reason: string };

/** Times are the platform's receive times, so a client's skewed clock cannot affect the check. */
function findEarlierTelemetry(
  attempt: AttemptToEvaluate,
  idName: string,
  firstReceivedAt: string | null,
): string | null {
  if (firstReceivedAt === null || new Date(firstReceivedAt) >= attempt.startedAt) return null;
  return `This ${idName} already had telemetry before the attempt started. ` +
    "Use a new value for every attempt.";
}

async function readGateResult(
  dependencies: IterationTelemetryGateDependencies,
  job: EvaluateAttemptJob,
  attempt: AttemptToEvaluate,
): Promise<TelemetryGateResult> {
  const { evaluationRunRepository, telemetryClient, timing, readCurrentTime } = dependencies;
  const { projectId, correlationIds, sessionId } = attempt;
  const conflict = await evaluationRunRepository.findTelemetryIdConflict(job, {
    correlationIds,
    sessionId,
  });
  if (conflict !== null) {
    return {
      status: "error",
      reason: `This ${conflict.idName} is also used by Test Case ${conflict.testCaseName}, ` +
        `Iteration ${conflict.iterationNumber}, attempt ${conflict.attemptNumber} of this run.`,
    };
  }
  const correlations = [];
  for (const correlationId of correlationIds) {
    const correlation = await telemetryClient.readCorrelation(projectId, correlationId);
    const earlierCorrelation = findEarlierTelemetry(
      attempt,
      "Correlation ID",
      correlation.firstReceivedAt,
    );
    if (earlierCorrelation !== null) return { status: "error", reason: earlierCorrelation };
    correlations.push(correlation);
  }
  if (sessionId !== null) {
    const session = await telemetryClient.readSession(projectId, sessionId);
    const earlierSession = findEarlierTelemetry(attempt, "session.id", session.firstReceivedAt);
    if (earlierSession !== null) return { status: "error", reason: earlierSession };
  }
  // A Session needs no idle timer: its last step marks its end, so each step's traces are awaited.
  const millisecondsSinceOutput = readCurrentTime().getTime() - attempt.reportedAt.getTime();
  const completions = correlations.map((correlation) =>
    decideTraceCompletion(correlation, millisecondsSinceOutput, timing)
  );
  for (const completion of completions) {
    if (completion.status === "timed_out") return { status: "error", reason: completion.reason };
  }
  if (completions.some((completion) => completion.status === "waiting")) {
    return { status: "waiting" };
  }
  const isSessionScoped = attempt.definition.scope === "session";
  const { spans, readAt, isTruncated } = isSessionScoped
    ? await telemetryClient.listSessionSpans(projectId, sessionId as string)
    : await telemetryClient.listSpans(projectId, correlationIds[0]);
  if (isTruncated) {
    return {
      status: "error",
      reason: `This ${
        isSessionScoped ? "Session" : "Correlation ID"
      } has more than ${spans.length} spans, too many to judge.`,
    };
  }
  // Marked first: if Telemetry cannot record it, the attempt waits and tries again.
  for (const correlationId of correlationIds) {
    await telemetryClient.markEvaluated(projectId, correlationId, readAt);
  }
  return { status: "ready", spans };
}

/**
 * Decides whether an attempt can be judged. A passing outage only makes it wait, until the same
 * timeout that applies to a missing root span.
 */
export async function passIterationTelemetryGate(
  dependencies: IterationTelemetryGateDependencies,
  job: EvaluateAttemptJob,
  attempt: AttemptToEvaluate,
): Promise<TelemetryGateResult> {
  try {
    return await readGateResult(dependencies, job, attempt);
  } catch (error) {
    if (error instanceof UnknownProjectError) {
      return { status: "error", reason: "The Project of this run no longer exists." };
    }
    if (
      !(error instanceof TelemetryUnavailableError) && !(error instanceof IdentityUnavailableError)
    ) {
      throw error;
    }
    const millisecondsSinceOutput = dependencies.readCurrentTime().getTime() -
      attempt.reportedAt.getTime();
    if (millisecondsSinceOutput < dependencies.timing.rootSpanTimeoutMilliseconds) {
      return { status: "waiting" };
    }
    return { status: "error", reason: "The telemetry could not be read in time." };
  }
}
