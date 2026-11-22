import type {
  SessionConversationResponse,
  SessionConversationTrace,
  Span,
} from "@extispex/contracts";

const INPUT_MESSAGES_ATTRIBUTE = "gen_ai.input.messages";
const OUTPUT_MESSAGES_ATTRIBUTE = "gen_ai.output.messages";
const TOOL_NAME_ATTRIBUTE = "gen_ai.tool.name";
const INPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.output_tokens";

/**
 * Builds a Session's conversation from the spans of its traces, each trace's spans ordered by
 * start time and the traces oldest first. The rules are in docs/architecture.md.
 */
export function buildSessionConversation(
  sessionId: string,
  traceSpanLists: Span[][],
  truncated: boolean,
): SessionConversationResponse {
  const traces = traceSpanLists
    .filter((traceSpans) => traceSpans.length > 0)
    .map(describeTrace);
  const traceStarts = traceSpanLists.flat().map((span) => BigInt(span.startTimeUnixNano));
  const traceEnds = traceSpanLists.flat().map((span) => BigInt(span.endTimeUnixNano));
  const firstStart = traceStarts.reduce(minimum);
  const lastEnd = traceEnds.reduce(maximum);
  return {
    sessionId,
    summary: {
      traceCount: traces.length,
      firstStartTimeUnixNano: firstStart.toString(),
      lastEndTimeUnixNano: lastEnd.toString(),
      durationMilliseconds: nanosecondsToMilliseconds(lastEnd - firstStart),
      inputTokens: sumKnown(traces.map((trace) => trace.inputTokens)),
      outputTokens: sumKnown(traces.map((trace) => trace.outputTokens)),
      tracesWithErrors: traces.filter((trace) => trace.errorSpanCount > 0).length,
    },
    traces,
    truncated,
  };
}

function describeTrace(spans: Span[]): SessionConversationTrace {
  const rootSpan = spans.find((span) => span.parentSpanId === null) ?? null;
  const representativeSpan = rootSpan ?? spans[0];
  const traceStart = spans.map((span) => BigInt(span.startTimeUnixNano)).reduce(minimum);
  const traceEnd = spans.map((span) => BigInt(span.endTimeUnixNano)).reduce(maximum);
  const errorSpans = spans.filter((span) => span.statusCode === "error");
  const usageSpans = findInnermostUsageSpans(spans);
  return {
    traceId: representativeSpan.traceId,
    rootSpanName: rootSpan?.name ?? null,
    serviceName: representativeSpan.serviceName,
    correlationId: representativeSpan.correlationId,
    startTimeUnixNano: traceStart.toString(),
    durationMilliseconds: nanosecondsToMilliseconds(
      traceEnd > traceStart ? traceEnd - traceStart : 0n,
    ),
    spanCount: spans.length,
    inputTokens: sumKnown(usageSpans.map((span) => readNumber(span, INPUT_TOKENS_ATTRIBUTE))),
    outputTokens: sumKnown(usageSpans.map((span) => readNumber(span, OUTPUT_TOKENS_ATTRIBUTE))),
    errorSpanCount: errorSpans.length,
    firstErrorMessage: errorSpans.find((span) => span.statusMessage)?.statusMessage ?? null,
    userMessage: readMessage(rootSpan, spans, INPUT_MESSAGES_ATTRIBUTE, "user", "earliest"),
    assistantMessage: readMessage(
      rootSpan,
      spans,
      OUTPUT_MESSAGES_ATTRIBUTE,
      "assistant",
      "latest",
    ),
    toolNames: spans
      .map((span) => span.attributes[TOOL_NAME_ATTRIBUTE])
      .filter((toolName): toolName is string => typeof toolName === "string" && toolName !== ""),
  };
}

/**
 * The text of the last message with the role, from the root span or else from the earliest or
 * latest span that carries the attribute.
 */
function readMessage(
  rootSpan: Span | null,
  spans: Span[],
  attributeKey: string,
  role: string,
  fallbackSpan: "earliest" | "latest",
): string | null {
  const rootMessage = rootSpan === null ? null : findLastMessageText(rootSpan, attributeKey, role);
  if (rootMessage !== null) return rootMessage;
  const carryingSpans = spans.filter((span) =>
    span !== rootSpan && parseMessages(span.attributes[attributeKey]) !== null
  );
  const chosenSpan = fallbackSpan === "earliest" ? carryingSpans.at(0) : carryingSpans.at(-1);
  return chosenSpan === undefined ? null : findLastMessageText(chosenSpan, attributeKey, role);
}

function findLastMessageText(span: Span, attributeKey: string, role: string): string | null {
  const messages = parseMessages(span.attributes[attributeKey]) ?? [];
  for (const message of messages.toReversed()) {
    if (!isRecord(message) || message.role !== role) continue;
    const text = readTextParts(message);
    if (text !== null) return text;
  }
  return null;
}

/** OpenTelemetry sends structured values on spans as a JSON string; OTLP may also send an array. */
function parseMessages(attributeValue: unknown): unknown[] | null {
  if (Array.isArray(attributeValue)) return attributeValue;
  if (typeof attributeValue !== "string") return null;
  try {
    const parsedValue: unknown = JSON.parse(attributeValue);
    return Array.isArray(parsedValue) ? parsedValue : null;
  } catch {
    return null;
  }
}

function readTextParts(message: Record<string, unknown>): string | null {
  if (!Array.isArray(message.parts)) return null;
  const texts = message.parts
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.content === "string")
    .map((part) => (part as { content: string }).content);
  return texts.length === 0 ? null : texts.join("\n");
}

/** Spans that report usage and have no descendant that does, so that no usage is counted twice. */
function findInnermostUsageSpans(spans: Span[]): Span[] {
  const usageSpans = spans.filter((span) =>
    readNumber(span, INPUT_TOKENS_ATTRIBUTE) !== null ||
    readNumber(span, OUTPUT_TOKENS_ATTRIBUTE) !== null
  );
  const parentBySpanId = new Map(spans.map((span) => [span.spanId, span.parentSpanId]));
  const spanIdsWithUsageBelow = new Set<string>();
  for (const usageSpan of usageSpans) {
    const visitedSpanIds = new Set<string>();
    let ancestorSpanId = usageSpan.parentSpanId;
    while (ancestorSpanId !== null && !visitedSpanIds.has(ancestorSpanId)) {
      visitedSpanIds.add(ancestorSpanId);
      spanIdsWithUsageBelow.add(ancestorSpanId);
      ancestorSpanId = parentBySpanId.get(ancestorSpanId) ?? null;
    }
  }
  return usageSpans.filter((span) => !spanIdsWithUsageBelow.has(span.spanId));
}

function readNumber(span: Span, attributeKey: string): number | null {
  const attributeValue = span.attributes[attributeKey];
  return typeof attributeValue === "number" && Number.isFinite(attributeValue)
    ? attributeValue
    : null;
}

function sumKnown(values: (number | null)[]): number | null {
  const knownValues = values.filter((value): value is number => value !== null);
  return knownValues.length === 0 ? null : knownValues.reduce((total, value) => total + value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function nanosecondsToMilliseconds(nanoseconds: bigint): number {
  return Number(nanoseconds) / 1_000_000;
}
