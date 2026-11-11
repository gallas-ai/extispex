import type { ReportedStep, TestCaseDefinition } from "@extispex/contracts";
import type { TargetClient, TargetEndpoint } from "../targets/target-client.ts";

export type ExecutionResult =
  | { status: "output"; output: string; correlationId: string; sessionId: string | null }
  | { status: "session_output"; steps: ReportedStep[] }
  | { status: "error"; error: string; steps: ReportedStep[] };

/** Calls the Target once for a trace-scoped Test Case. */
async function executeTrace(
  targetClient: TargetClient,
  endpoint: TargetEndpoint,
  input: unknown,
): Promise<ExecutionResult> {
  const answer = await targetClient.callTarget(endpoint, { input, sessionId: null });
  if (answer.status === "error") return { status: "error", error: answer.reason, steps: [] };
  return {
    status: "output",
    output: answer.output,
    correlationId: answer.correlationId,
    sessionId: answer.sessionId,
  };
}

/**
 * Runs a Session Test Case's steps in order, passing on the `session.id` the Target returned first.
 * The first step that goes wrong ends the attempt; the steps before it stay in the Transcript.
 */
async function executeSession(
  targetClient: TargetClient,
  endpoint: TargetEndpoint,
  stepInputs: { input: unknown }[],
): Promise<ExecutionResult> {
  const steps: ReportedStep[] = [];
  let sessionId: string | null = null;
  for (const [stepIndex, { input }] of stepInputs.entries()) {
    const answer = await targetClient.callTarget(endpoint, { input, sessionId });
    const stepNumber = stepIndex + 1;
    if (answer.status === "error") {
      return { status: "error", error: `Step ${stepNumber}: ${answer.reason}`, steps };
    }
    if (answer.sessionId === null) {
      return {
        status: "error",
        error: `Step ${stepNumber}: A Session Test Case needs a sessionId in the Target's answer.`,
        steps,
      };
    }
    if (sessionId !== null && answer.sessionId !== sessionId) {
      return {
        status: "error",
        error: `Step ${stepNumber}: The Target changed the sessionId within one Session.`,
        steps,
      };
    }
    sessionId = answer.sessionId;
    steps.push({ output: answer.output, correlationId: answer.correlationId, sessionId });
  }
  return { status: "session_output", steps };
}

export function executeIterationAgainstTarget(
  targetClient: TargetClient,
  endpoint: TargetEndpoint,
  definition: TestCaseDefinition,
): Promise<ExecutionResult> {
  return definition.scope === "session"
    ? executeSession(targetClient, endpoint, definition.steps ?? [])
    : executeTrace(targetClient, endpoint, definition.input);
}
