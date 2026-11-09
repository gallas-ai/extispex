import {
  type EvaluatorResult,
  type MatchedSpanSummary,
  MAXIMUM_MATCHED_SPAN_SUMMARIES,
  type Span,
  type TelemetryEvaluator,
} from "@extispex/contracts";

function matchesSpan({ match }: TelemetryEvaluator, span: Span): boolean {
  if (match.name !== undefined && span.name !== match.name) return false;
  if (match.status !== undefined && span.statusCode !== match.status) return false;
  return Object.entries(match.attributes).every(([attributeKey, expectedValue]) =>
    span.attributes[attributeKey] === expectedValue
  );
}

function describeExpectedCount({ count }: TelemetryEvaluator): string {
  if (count.max === undefined) return `at least ${count.min}`;
  return count.min === count.max ? `exactly ${count.min}` : `${count.min} to ${count.max}`;
}

/** A copy that keeps only what the Evaluator tested, so that a result stays small. */
function summarizeSpan(evaluator: TelemetryEvaluator, span: Span): MatchedSpanSummary {
  const attributes: Record<string, unknown> = {};
  for (const attributeKey of Object.keys(evaluator.match.attributes)) {
    attributes[attributeKey] = span.attributes[attributeKey];
  }
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    statusCode: span.statusCode,
    durationMilliseconds: span.durationMilliseconds,
    serviceName: span.serviceName,
    attributes,
  };
}

/** Counts the spans that meet the Evaluator's conditions and compares that with what it expects. */
export function runTelemetryEvaluator(
  evaluator: TelemetryEvaluator,
  spans: Span[],
): EvaluatorResult {
  const matchedSpans = spans.filter((span) => matchesSpan(evaluator, span));
  const matchedCount = matchedSpans.length;
  const isWithinCount = matchedCount >= evaluator.count.min &&
    (evaluator.count.max === undefined || matchedCount <= evaluator.count.max);
  const spanWord = matchedCount === 1 ? "span matches" : "spans match";
  return {
    name: evaluator.name,
    type: "telemetry",
    outcome: isWithinCount ? "passed" : "failed",
    reason: `${matchedCount} of ${spans.length} ${spanWord}; expected ${
      describeExpectedCount(evaluator)
    }.`,
    matchedSpanCount: matchedCount,
    matchedSpans: matchedSpans.slice(0, MAXIMUM_MATCHED_SPAN_SUMMARIES).map((span) =>
      summarizeSpan(evaluator, span)
    ),
  };
}
