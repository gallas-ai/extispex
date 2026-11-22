import { assertEquals } from "@std/assert";
import {
  createRequestAuthenticator,
  createStructuredLogger,
  type ProjectResolver,
} from "@extispex/service-runtime";
import {
  createTestAccessTokens,
  createTestProjectLifecycle,
} from "@extispex/service-runtime/testing";
import { listTestDatabases } from "@extispex/service-storage/testing";
import type { SessionConversationResponse } from "@extispex/contracts";
import {
  createTelemetryService,
  openTelemetryDatabase,
  type TelemetryService,
} from "../src/create-service.ts";

const API_KEY = "test-api-key";
const OTHER_PROJECT_API_KEY = "other-project-api-key";
const SESSION_ID = "chat-7";
const BASE_NANOSECONDS = 1_700_000_000_000_000_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

const testProjectResolver: ProjectResolver = {
  resolveProjectId: (apiKey) =>
    Promise.resolve(
      ({ [API_KEY]: "project-one", [OTHER_PROJECT_API_KEY]: "project-two" })[apiKey] ?? null,
    ),
};
const testAccessTokens = await createTestAccessTokens();
const testRequestAuthenticator = createRequestAuthenticator({
  projectResolver: testProjectResolver,
  accessTokenVerifier: testAccessTokens.accessTokenVerifier,
});

type OtlpValue =
  | { stringValue: string }
  | { intValue: number }
  | { arrayValue: { values: OtlpValue[] } }
  | { kvlistValue: { values: { key: string; value: OtlpValue }[] } };

interface TestSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMilliseconds: number;
  endMilliseconds: number;
  attributes?: Record<string, string | number | OtlpValue>;
  status?: { code: number; message?: string };
}

interface TestTrace {
  traceId: string;
  correlationId: string;
  sessionId?: string;
  spans: TestSpan[];
}

function toOtlpValue(value: string | number | OtlpValue): OtlpValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { intValue: value };
  return value;
}

function createTracePayload(traces: TestTrace[]) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "support-bot" } }] },
      scopeSpans: [{
        spans: traces.flatMap((trace) =>
          trace.spans.map((span) => ({
            traceId: trace.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            kind: 1,
            startTimeUnixNano: String(
              BASE_NANOSECONDS + BigInt(span.startMilliseconds) * NANOSECONDS_PER_MILLISECOND,
            ),
            endTimeUnixNano: String(
              BASE_NANOSECONDS + BigInt(span.endMilliseconds) * NANOSECONDS_PER_MILLISECOND,
            ),
            attributes: Object.entries({
              "correlation.id": trace.correlationId,
              ...(trace.sessionId === undefined ? {} : { "session.id": trace.sessionId }),
              ...span.attributes,
            }).map(([key, value]) => ({ key, value: toOtlpValue(value) })),
            status: span.status,
          }))
        ),
      }],
    }],
  };
}

function textMessages(...messages: [role: string, text: string][]): string {
  return JSON.stringify(
    messages.map(([role, text]) => ({ role, parts: [{ type: "text", content: text }] })),
  );
}

type SessionTestBody = (service: TelemetryService) => Promise<void>;

function defineSessionTest(testName: string, testBody: SessionTestBody): void {
  for (const testDatabase of listTestDatabases("telemetry")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openTelemetryDatabase(testDatabase.url);
      try {
        await database.orm.em.fork().execute("delete from spans");
        await testBody(createTelemetryService({
          database,
          requestAuthenticator: testRequestAuthenticator,
          projectLifecycle: createTestProjectLifecycle(),
          logger: createStructuredLogger("telemetry-test"),
        }));
      } finally {
        await database.close();
      }
    });
  }
}

async function sendTraces(
  service: TelemetryService,
  traces: TestTrace[],
  apiKey = API_KEY,
): Promise<void> {
  const response = await service.handleRequest(
    new Request("http://telemetry.test/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(createTracePayload(traces)),
    }),
  );
  assertEquals(response.status, 200, await response.text());
}

function requestSession(service: TelemetryService, sessionId: string, apiKey = API_KEY) {
  return service.handleRequest(
    new Request(`http://telemetry.test/v1/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  );
}

async function readSession(
  service: TelemetryService,
  sessionId = SESSION_ID,
): Promise<SessionConversationResponse> {
  const response = await requestSession(service, sessionId);
  const responseText = await response.text();
  assertEquals(response.status, 200, responseText);
  return JSON.parse(responseText);
}

function traceId(traceNumber: number): string {
  return traceNumber.toString(16).padStart(32, "0");
}

function spanId(traceNumber: number, spanNumber: number): string {
  return `${traceNumber.toString(16).padStart(8, "0")}${spanNumber.toString(16).padStart(8, "0")}`;
}

defineSessionTest(
  "shows a Session's traces oldest first with the messages of their root spans",
  async (service) => {
    await sendTraces(
      service,
      [2, 1].map((traceNumber) => ({
        traceId: traceId(traceNumber),
        correlationId: `order-${traceNumber}`,
        sessionId: SESSION_ID,
        spans: [{
          spanId: spanId(traceNumber, 1),
          name: "handle-message",
          startMilliseconds: traceNumber * 1000,
          endMilliseconds: traceNumber * 1000 + 250,
          attributes: {
            "gen_ai.input.messages": textMessages(
              ["system", "You are a support bot."],
              ["user", `Question ${traceNumber}`],
            ),
            "gen_ai.output.messages": textMessages(["assistant", `Answer ${traceNumber}`]),
          },
        }],
      })),
    );

    const conversation = await readSession(service);

    assertEquals(conversation.sessionId, SESSION_ID);
    assertEquals(conversation.truncated, false);
    assertEquals(
      conversation.traces.map((
        trace,
      ) => [trace.correlationId, trace.userMessage, trace.assistantMessage]),
      [["order-1", "Question 1", "Answer 1"], ["order-2", "Question 2", "Answer 2"]],
    );
    assertEquals(conversation.traces[0].rootSpanName, "handle-message");
    assertEquals(conversation.traces[0].durationMilliseconds, 250);
    assertEquals(conversation.summary.traceCount, 2);
    assertEquals(conversation.summary.durationMilliseconds, 1250);
    assertEquals(
      conversation.summary.firstStartTimeUnixNano,
      String(BASE_NANOSECONDS + 1000n * NANOSECONDS_PER_MILLISECOND),
    );
  },
);

defineSessionTest(
  "reads the newest user message of the first chat span and the reply of the last one",
  async (service) => {
    await sendTraces(service, [{
      traceId: traceId(1),
      correlationId: "order-1",
      sessionId: SESSION_ID,
      spans: [
        {
          spanId: spanId(1, 1),
          name: "handle-message",
          startMilliseconds: 0,
          endMilliseconds: 900,
        },
        {
          spanId: spanId(1, 2),
          parentSpanId: spanId(1, 1),
          name: "chat model-one",
          startMilliseconds: 10,
          endMilliseconds: 300,
          attributes: {
            "gen_ai.input.messages": textMessages(
              ["user", "Earlier question"],
              ["assistant", "Earlier answer"],
              ["user", "Can I cancel order 42?"],
            ),
            "gen_ai.output.messages": textMessages(["assistant", "Let me check."]),
          },
        },
        {
          spanId: spanId(1, 3),
          parentSpanId: spanId(1, 1),
          name: "execute_tool cancel_order",
          startMilliseconds: 310,
          endMilliseconds: 400,
          attributes: { "gen_ai.tool.name": "cancel_order" },
        },
        {
          spanId: spanId(1, 4),
          parentSpanId: spanId(1, 1),
          name: "chat model-one",
          startMilliseconds: 410,
          endMilliseconds: 800,
          attributes: {
            "gen_ai.input.messages": textMessages(["user", "Can I cancel order 42?"]),
            "gen_ai.output.messages": textMessages(["assistant", "Order 42 is cancelled."]),
          },
        },
      ],
    }]);

    const [trace] = (await readSession(service)).traces;

    assertEquals(trace.userMessage, "Can I cancel order 42?");
    assertEquals(trace.assistantMessage, "Order 42 is cancelled.");
    assertEquals(trace.toolNames, ["cancel_order"]);
    assertEquals(trace.spanCount, 4);
  },
);

defineSessionTest("accepts messages sent as an array instead of a JSON string", async (service) => {
  const textPart = (text: string): OtlpValue => ({
    kvlistValue: {
      values: [
        { key: "type", value: { stringValue: "text" } },
        { key: "content", value: { stringValue: text } },
      ],
    },
  });
  const message = (role: string, parts: OtlpValue[]): OtlpValue => ({
    kvlistValue: {
      values: [
        { key: "role", value: { stringValue: role } },
        { key: "parts", value: { arrayValue: { values: parts } } },
      ],
    },
  });
  await sendTraces(service, [{
    traceId: traceId(1),
    correlationId: "order-1",
    sessionId: SESSION_ID,
    spans: [{
      spanId: spanId(1, 1),
      name: "invoke_agent support",
      startMilliseconds: 0,
      endMilliseconds: 10,
      attributes: {
        "gen_ai.input.messages": { arrayValue: { values: [message("user", [textPart("Hi")])] } },
        "gen_ai.output.messages": {
          arrayValue: {
            values: [message("assistant", [textPart("Hello,"), textPart("how can I help?")])],
          },
        },
      },
    }],
  }]);

  const [trace] = (await readSession(service)).traces;

  assertEquals(trace.userMessage, "Hi");
  assertEquals(trace.assistantMessage, "Hello,\nhow can I help?");
});

defineSessionTest("shows a trace without messages by its statistics only", async (service) => {
  await sendTraces(service, [{
    traceId: traceId(1),
    correlationId: "order-1",
    sessionId: SESSION_ID,
    spans: [{
      spanId: spanId(1, 1),
      name: "handle-message",
      startMilliseconds: 0,
      endMilliseconds: 10,
      attributes: { "gen_ai.input.messages": "not json" },
    }],
  }]);

  const [trace] = (await readSession(service)).traces;

  assertEquals(trace.userMessage, null);
  assertEquals(trace.assistantMessage, null);
  assertEquals(trace.toolNames, []);
  assertEquals(trace.inputTokens, null);
});

defineSessionTest(
  "adds up tokens without counting a parent's total twice, and reports errors",
  async (service) => {
    await sendTraces(
      service,
      [1, 2].map((traceNumber) => ({
        traceId: traceId(traceNumber),
        correlationId: `order-${traceNumber}`,
        sessionId: SESSION_ID,
        spans: [
          {
            spanId: spanId(traceNumber, 1),
            name: "invoke_agent support",
            startMilliseconds: traceNumber * 1000,
            endMilliseconds: traceNumber * 1000 + 500,
            attributes: { "gen_ai.usage.input_tokens": 150, "gen_ai.usage.output_tokens": 30 },
          },
          {
            spanId: spanId(traceNumber, 2),
            parentSpanId: spanId(traceNumber, 1),
            name: "chat model-one",
            startMilliseconds: traceNumber * 1000 + 10,
            endMilliseconds: traceNumber * 1000 + 200,
            attributes: { "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20 },
          },
          {
            spanId: spanId(traceNumber, 3),
            parentSpanId: spanId(traceNumber, 1),
            name: "chat model-one",
            startMilliseconds: traceNumber * 1000 + 210,
            endMilliseconds: traceNumber * 1000 + 400,
            attributes: { "gen_ai.usage.input_tokens": 50, "gen_ai.usage.output_tokens": 10 },
            status: traceNumber === 2 ? { code: 2, message: "Rate limited" } : undefined,
          },
        ],
      })),
    );

    const conversation = await readSession(service);

    assertEquals(
      conversation.traces.map((trace) => [trace.inputTokens, trace.outputTokens]),
      [[150, 30], [150, 30]],
    );
    assertEquals(conversation.traces[1].errorSpanCount, 1);
    assertEquals(conversation.traces[1].firstErrorMessage, "Rate limited");
    assertEquals(conversation.traces[0].errorSpanCount, 0);
    assertEquals(conversation.summary.inputTokens, 300);
    assertEquals(conversation.summary.outputTokens, 60);
    assertEquals(conversation.summary.tracesWithErrors, 1);
  },
);

defineSessionTest(
  "holds the first 500 traces and says that the Session has more",
  async (service) => {
    const traces = Array.from({ length: 501 }, (_, traceIndex) => ({
      traceId: traceId(traceIndex + 1),
      correlationId: `order-${traceIndex + 1}`,
      sessionId: SESSION_ID,
      spans: [{
        spanId: spanId(traceIndex + 1, 1),
        name: "handle-message",
        startMilliseconds: traceIndex * 10,
        endMilliseconds: traceIndex * 10 + 5,
      }],
    }));
    await sendTraces(service, traces);

    const conversation = await readSession(service);

    assertEquals(conversation.truncated, true);
    assertEquals(conversation.traces.length, 500);
    assertEquals(conversation.traces[0].correlationId, "order-1");
    assertEquals(conversation.traces.at(-1)?.correlationId, "order-500");
  },
);

defineSessionTest("answers 404 for a Session of another Project", async (service) => {
  await sendTraces(service, [{
    traceId: traceId(1),
    correlationId: "order-1",
    sessionId: SESSION_ID,
    spans: [{
      spanId: spanId(1, 1),
      name: "handle-message",
      startMilliseconds: 0,
      endMilliseconds: 1,
    }],
  }], OTHER_PROJECT_API_KEY);

  const response = await requestSession(service, SESSION_ID);

  assertEquals(response.status, 404);
  assertEquals((await response.json()).error.code, "not_found");
});

defineSessionTest("requires a valid API key", async (service) => {
  const response = await requestSession(service, SESSION_ID, "unknown-key");
  await response.body?.cancel();
  assertEquals(response.status, 401);
});
