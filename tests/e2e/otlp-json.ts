/** Sends spans the way an instrumented application would, as OTLP/JSON over HTTP. */
import { assertEquals } from "@std/assert";
import type { RunningDeployment } from "./deployment.ts";

export interface TestSpan {
  name: string;
  /** Omit for a root span. */
  parentSpanId?: string;
  spanId?: string;
  attributes?: Record<string, string>;
}

function randomHex(byteCount: number): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(byteCount)),
    (byteValue) => byteValue.toString(16).padStart(2, "0"),
  ).join("");
}

export function createTraceId(): string {
  return randomHex(16);
}

/** Stores spans of one trace and fails the test unless Telemetry accepted all of them. */
export async function sendSpans(
  deployment: RunningDeployment,
  traceId: string,
  telemetryIds: { correlationId: string; sessionId?: string },
  spans: TestSpan[],
): Promise<void> {
  const startNanoseconds = BigInt(Date.now()) * 1_000_000n;
  const toAttributes = (attributes: Record<string, string>) =>
    Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } }));
  const response = await fetch(`${deployment.otlpHttpUrl}/v1/traces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deployment.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: toAttributes({ "service.name": "e2e-support-bot" }) },
        scopeSpans: [{
          spans: spans.map((span) => ({
            traceId,
            spanId: span.spanId ?? randomHex(8),
            parentSpanId: span.parentSpanId,
            name: span.name,
            kind: 1,
            startTimeUnixNano: String(startNanoseconds),
            endTimeUnixNano: String(startNanoseconds + 1_000_000n),
            attributes: toAttributes({
              "correlation.id": telemetryIds.correlationId,
              ...(telemetryIds.sessionId === undefined
                ? {}
                : { "session.id": telemetryIds.sessionId }),
              ...span.attributes,
            }),
            status: { code: 1 },
          })),
        }],
      }],
    }),
  });
  assertEquals(response.status, 200, await response.clone().text());
  await response.body?.cancel();
}

/** A root span with a tool call below it, as a typical request of the application produces. */
export function createToolCallSpans(toolName: string): TestSpan[] {
  const rootSpanId = randomHex(8);
  return [
    { name: "handle-message", spanId: rootSpanId },
    {
      name: "execute_tool",
      parentSpanId: rootSpanId,
      attributes: { "gen_ai.tool.name": toolName },
    },
  ];
}
