import { assertEquals, assertStringIncludes } from "@std/assert";
import { createStructuredLogger } from "@extispex/service-runtime";
import type { ListTracesResponse, TraceDetailResponse } from "@extispex/contracts";
import {
  createStaticApiKeyProjectResolver,
  createTelemetryService,
  openTelemetryDatabase,
  type TelemetryService,
} from "../src/create-service.ts";

const API_KEY = "test-api-key";
const OTHER_PROJECT_API_KEY = "other-project-api-key";
const TRACE_ID = "5b8efff798038103d269b633813fc60c";
const ROOT_SPAN_ID = "eee19b7ec3c1b174";
const CHILD_SPAN_ID = "eee19b7ec3c1b175";

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function createJsonTraceRequest(options: { includeCorrelationIdOnChild: boolean }) {
  const childAttributes = [stringAttribute("gen_ai.request.model", "model-one")];
  if (options.includeCorrelationIdOnChild) {
    childAttributes.push(stringAttribute("correlation.id", "order-42"));
  }
  return {
    resourceSpans: [{
      resource: { attributes: [stringAttribute("service.name", "support-bot")] },
      scopeSpans: [{
        spans: [
          {
            traceId: TRACE_ID,
            spanId: ROOT_SPAN_ID,
            name: "handle-message",
            kind: 2,
            startTimeUnixNano: "1700000000000000000",
            endTimeUnixNano: "1700000000250000000",
            attributes: [
              stringAttribute("correlation.id", "order-42"),
              stringAttribute("session.id", "chat-7"),
            ],
            status: { code: 1 },
          },
          {
            traceId: TRACE_ID,
            spanId: CHILD_SPAN_ID,
            parentSpanId: ROOT_SPAN_ID,
            name: "chat model-one",
            kind: 3,
            startTimeUnixNano: "1700000000010000000",
            endTimeUnixNano: "1700000000200000000",
            attributes: childAttributes,
          },
        ],
      }],
    }],
  };
}

/** SQLite always runs; PostgreSQL runs when TELEMETRY_TEST_POSTGRES_URL is set. */
const testDatabaseUrls = ["sqlite::memory:"];
const postgresTestUrl = Deno.env.get("TELEMETRY_TEST_POSTGRES_URL");
if (postgresTestUrl) {
  testDatabaseUrls.push(postgresTestUrl);
}

type TelemetryTestBody = (telemetryService: TelemetryService) => Promise<void>;

function defineTelemetryTest(testName: string, testBody: TelemetryTestBody): void {
  for (const databaseUrl of testDatabaseUrls) {
    const databaseLabel = databaseUrl.startsWith("sqlite:") ? "sqlite" : "postgresql";
    Deno.test(`${testName} (${databaseLabel})`, () => withTelemetryService(databaseUrl, testBody));
  }
}

async function withTelemetryService(
  databaseUrl: string,
  testBody: TelemetryTestBody,
): Promise<void> {
  const database = await openTelemetryDatabase(databaseUrl);
  try {
    await database.orm.em.fork().execute("delete from spans");
    await testBody(createTelemetryService({
      database,
      projectResolver: createStaticApiKeyProjectResolver(
        `${API_KEY}=project-one,${OTHER_PROJECT_API_KEY}=project-two`,
      ),
      logger: createStructuredLogger("telemetry-test"),
    }));
  } finally {
    await database.close();
  }
}

function sendRequest(
  telemetryService: TelemetryService,
  path: string,
  init: RequestInit & { apiKey?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${init.apiKey ?? API_KEY}`);
  return telemetryService.handleRequest(
    new Request(`http://telemetry.test${path}`, { ...init, headers }),
  );
}

function postJsonTraces(telemetryService: TelemetryService, payload: unknown) {
  return sendRequest(telemetryService, "/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

defineTelemetryTest(
  "stores OTLP/JSON spans and finds the trace by Correlation ID",
  async (telemetryService) => {
    const ingestionResponse = await postJsonTraces(
      telemetryService,
      createJsonTraceRequest({ includeCorrelationIdOnChild: true }),
    );
    assertEquals(ingestionResponse.status, 200);
    assertEquals(await ingestionResponse.json(), {});

    const listResponse = await sendRequest(telemetryService, "/v1/traces?correlationId=order-42");
    const { traces } = await listResponse.json() as ListTracesResponse;
    assertEquals(traces.length, 1);
    assertEquals(traces[0], {
      traceId: TRACE_ID,
      rootSpanName: "handle-message",
      serviceName: "support-bot",
      correlationId: "order-42",
      sessionId: "chat-7",
      startTimeUnixNano: "1700000000000000000",
      durationMilliseconds: 250,
      spanCount: 2,
      hasRootSpan: true,
    });

    const detailResponse = await sendRequest(telemetryService, `/v1/traces/${TRACE_ID}`);
    const traceDetail = await detailResponse.json() as TraceDetailResponse;
    assertEquals(traceDetail.spans.map((span) => span.name), ["handle-message", "chat model-one"]);
    assertEquals(traceDetail.spans[1].parentSpanId, ROOT_SPAN_ID);
    assertEquals(traceDetail.spans[1].attributes["gen_ai.request.model"], "model-one");
    assertEquals(traceDetail.spans[1].kind, "client");
  },
);

defineTelemetryTest(
  "rejects spans without a Correlation ID through partial success",
  async (telemetryService) => {
    const ingestionResponse = await postJsonTraces(
      telemetryService,
      createJsonTraceRequest({ includeCorrelationIdOnChild: false }),
    );
    const responseBody = await ingestionResponse.json();
    assertEquals(ingestionResponse.status, 200);
    assertEquals(responseBody.partialSuccess.rejectedSpans, 1);
    assertStringIncludes(
      responseBody.partialSuccess.errorMessage,
      "missing required attribute correlation.id",
    );

    const detailResponse = await sendRequest(telemetryService, `/v1/traces/${TRACE_ID}`);
    const traceDetail = await detailResponse.json() as TraceDetailResponse;
    assertEquals(traceDetail.spans.map((span) => span.spanId), [ROOT_SPAN_ID]);
  },
);

defineTelemetryTest("ignores spans that an exporter sends again", async (telemetryService) => {
  const payload = createJsonTraceRequest({ includeCorrelationIdOnChild: true });
  await postJsonTraces(telemetryService, payload);
  const retryResponse = await postJsonTraces(telemetryService, payload);
  assertEquals(retryResponse.status, 200);

  const listResponse = await sendRequest(telemetryService, "/v1/traces");
  const { traces } = await listResponse.json() as ListTracesResponse;
  assertEquals(traces[0].spanCount, 2);
});

defineTelemetryTest("keeps each Project's traces separate", async (telemetryService) => {
  await postJsonTraces(
    telemetryService,
    createJsonTraceRequest({ includeCorrelationIdOnChild: true }),
  );
  const otherProjectResponse = await sendRequest(telemetryService, `/v1/traces/${TRACE_ID}`, {
    apiKey: OTHER_PROJECT_API_KEY,
  });
  assertEquals(otherProjectResponse.status, 404);
});

defineTelemetryTest("requires a valid API key", async (telemetryService) => {
  const response = await sendRequest(telemetryService, "/v1/traces", { apiKey: "unknown-key" });
  assertEquals(response.status, 401);
  await response.body?.cancel();
});

defineTelemetryTest(
  "answers invalid query parameters with a validation error",
  async (telemetryService) => {
    const response = await sendRequest(telemetryService, "/v1/traces?limit=0");
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error.code, "invalid_request");
  },
);

defineTelemetryTest("publishes an OpenAPI 3.1 document", async (telemetryService) => {
  const response = await sendRequest(telemetryService, "/openapi.json");
  const openApiDocument = await response.json();
  assertEquals(openApiDocument.openapi, "3.1.0");
  assertEquals(Object.keys(openApiDocument.paths).sort(), ["/v1/traces", "/v1/traces/{traceId}"]);
});
