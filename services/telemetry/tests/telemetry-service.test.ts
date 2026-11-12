import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createRequestAuthenticator,
  createStructuredLogger,
  IdentityUnavailableError,
  type ProjectResolver,
} from "@extispex/service-runtime";
import {
  createTestAccessTokens,
  createTestProjectLifecycle,
} from "@extispex/service-runtime/testing";
import { listTestDatabases } from "@extispex/service-storage/testing";
import type {
  CorrelationSpansResponse,
  CorrelationTelemetryResponse,
  ListTracesResponse,
  SessionTelemetryResponse,
  TraceDetailResponse,
} from "@extispex/contracts";
import {
  createTelemetryService,
  openTelemetryDatabase,
  type TelemetryService,
} from "../src/create-service.ts";

const API_KEY = "test-api-key";
const OTHER_PROJECT_API_KEY = "other-project-api-key";

/** Stands in for Identity: two keys, each in its own Project. */
const testProjectResolver: ProjectResolver = {
  resolveProjectId: (apiKey) =>
    Promise.resolve(
      ({ [API_KEY]: "project-one", [OTHER_PROJECT_API_KEY]: "project-two" })[apiKey] ?? null,
    ),
};

/** Stands in for Identity's signing key, for access tokens with a Role. */
const testAccessTokens = await createTestAccessTokens();
const testRequestAuthenticator = createRequestAuthenticator({
  projectResolver: testProjectResolver,
  accessTokenVerifier: testAccessTokens.accessTokenVerifier,
});
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

type TelemetryTestBody = (telemetryService: TelemetryService) => Promise<void>;

function defineTelemetryTest(testName: string, testBody: TelemetryTestBody): void {
  for (const testDatabase of listTestDatabases("telemetry")) {
    Deno.test(
      `${testName} (${testDatabase.label})`,
      () => withTelemetryService(testDatabase.url, testBody),
    );
  }
}

async function withTelemetryService(
  databaseUrl: string,
  testBody: TelemetryTestBody,
): Promise<void> {
  const database = await openTelemetryDatabase(databaseUrl);
  try {
    await database.orm.em.fork().execute("delete from spans");
    await database.orm.em.fork().execute("delete from correlation_evaluations");
    await testBody(createTelemetryService({
      database,
      requestAuthenticator: testRequestAuthenticator,
      projectLifecycle: createTestProjectLifecycle(),
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

async function compressBody(body: string, contentEncoding: CompressionFormat) {
  const compressedStream = new Blob([body]).stream().pipeThrough(
    new CompressionStream(contentEncoding),
  );
  return new Uint8Array(await new Response(compressedStream).arrayBuffer());
}

for (const contentEncoding of ["gzip", "deflate"] as const) {
  defineTelemetryTest(`stores OTLP/JSON spans sent with ${contentEncoding}`, async (service) => {
    const payload = createJsonTraceRequest({ includeCorrelationIdOnChild: true });
    const ingestionResponse = await sendRequest(service, "/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": contentEncoding },
      body: await compressBody(JSON.stringify(payload), contentEncoding),
    });
    assertEquals(ingestionResponse.status, 200, await ingestionResponse.clone().text());
    await ingestionResponse.body?.cancel();

    const detailResponse = await sendRequest(service, `/v1/traces/${TRACE_ID}`);
    const traceDetail = await detailResponse.json() as TraceDetailResponse;
    assertEquals(traceDetail.spans.length, 2);
  });
}

const MAXIMUM_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** A gzip body that is small on the wire and decompresses to `decompressedBytes` of zeros. */
function createGzipBomb(decompressedBytes: number) {
  const chunkBytes = 1024 * 1024;
  const progress = { generatedBytes: 0 };
  const zeroStream = new ReadableStream<BufferSource>({
    pull(controller) {
      if (progress.generatedBytes >= decompressedBytes) {
        controller.close();
        return;
      }
      progress.generatedBytes += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return { body: zeroStream.pipeThrough(new CompressionStream("gzip")), progress };
}

defineTelemetryTest(
  "stops reading a compressed payload once it decompresses past the limit",
  async (telemetryService) => {
    const gzipBomb = createGzipBomb(2 * MAXIMUM_PAYLOAD_BYTES);
    const response = await sendRequest(telemetryService, "/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip" },
      body: gzipBomb.body,
    });
    assertEquals(response.status, 413);
    assertEquals((await response.json()).error.code, "payload_too_large");
    const readAheadAllowance = 8 * 1024 * 1024;
    assert(
      gzipBomb.progress.generatedBytes <= MAXIMUM_PAYLOAD_BYTES + readAheadAllowance,
      `read ${gzipBomb.progress.generatedBytes} decompressed bytes`,
    );
  },
);

defineTelemetryTest(
  "answers an unsupported Content-Encoding with the encodings it accepts",
  async (telemetryService) => {
    const response = await sendRequest(telemetryService, "/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]),
    });
    assertEquals(response.status, 415);
    assertEquals(response.headers.get("accept-encoding"), "gzip, deflate");
    assertEquals((await response.json()).error.code, "unsupported_content_encoding");
  },
);

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
  "lets a viewer query traces but not send telemetry",
  async (telemetryService) => {
    await postJsonTraces(
      telemetryService,
      createJsonTraceRequest({ includeCorrelationIdOnChild: true }),
    );
    const viewerToken = await testAccessTokens.issueAccessToken({
      projectId: "project-one",
      role: "viewer",
    });
    const traceResponse = await sendRequest(telemetryService, `/v1/traces/${TRACE_ID}`, {
      apiKey: viewerToken,
    });
    assertEquals(traceResponse.status, 200);
    await traceResponse.body?.cancel();

    const ingestionResponse = await sendRequest(telemetryService, "/v1/traces", {
      method: "POST",
      apiKey: viewerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createJsonTraceRequest({ includeCorrelationIdOnChild: true })),
    });
    assertEquals(ingestionResponse.status, 403);
    await ingestionResponse.body?.cancel();
  },
);

Deno.test("asks clients to retry while API keys cannot be checked", async () => {
  const database = await openTelemetryDatabase("sqlite::memory:");
  try {
    const telemetryService = createTelemetryService({
      database,
      requestAuthenticator: createRequestAuthenticator({
        projectResolver: {
          resolveProjectId: () => Promise.reject(new IdentityUnavailableError("Identity is down.")),
        },
        accessTokenVerifier: testAccessTokens.accessTokenVerifier,
      }),
      projectLifecycle: createTestProjectLifecycle(),
      logger: { ...createStructuredLogger("telemetry-test"), warn: () => {} },
    });
    for (
      const response of [
        await postJsonTraces(
          telemetryService,
          createJsonTraceRequest({
            includeCorrelationIdOnChild: true,
          }),
        ),
        await sendRequest(telemetryService, "/v1/traces"),
      ]
    ) {
      assertEquals(response.status, 503);
      assertEquals(response.headers.get("retry-after"), "5");
      assertEquals((await response.json()).error.code, "identity_unavailable");
    }
  } finally {
    await database.close();
  }
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
  assertEquals(Object.keys(openApiDocument.paths).sort(), [
    "/internal/v1/correlations/{correlationId}",
    "/internal/v1/correlations/{correlationId}/evaluated",
    "/internal/v1/correlations/{correlationId}/spans",
    "/internal/v1/sessions/{sessionId}",
    "/internal/v1/sessions/{sessionId}/spans",
    "/v1/logs",
    "/v1/metrics",
    "/v1/metrics/attributes",
    "/v1/metrics/query",
    "/v1/rejected-telemetry",
    "/v1/traces",
    "/v1/traces/{traceId}",
  ]);
});

function issueServiceToken(projectId = "project-one") {
  return testAccessTokens.issueAccessToken({
    subject: "service:evaluation",
    projectId,
    role: "viewer",
  });
}

async function readInternal<ResponseBody>(
  telemetryService: TelemetryService,
  path: string,
  projectId?: string,
): Promise<ResponseBody> {
  const response = await sendRequest(telemetryService, path, {
    apiKey: await issueServiceToken(projectId),
  });
  const responseText = await response.text();
  assertEquals(response.status, 200, responseText);
  return JSON.parse(responseText) as ResponseBody;
}

async function markEvaluated(
  telemetryService: TelemetryService,
  correlationId: string,
  evaluatedAt: Date,
) {
  const response = await sendRequest(
    telemetryService,
    `/internal/v1/correlations/${correlationId}/evaluated`,
    {
      apiKey: await issueServiceToken(),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluatedAt: evaluatedAt.toISOString() }),
    },
  );
  assertEquals(response.status, 204, await response.clone().text());
}

defineTelemetryTest("says when a Correlation ID's telemetry was stored", async (service) => {
  const emptyState = await readInternal<CorrelationTelemetryResponse>(
    service,
    "/internal/v1/correlations/order-42",
  );
  assertEquals(emptyState.firstReceivedAt, null);
  assertEquals(emptyState.traces, []);

  await postJsonTraces(service, createJsonTraceRequest({ includeCorrelationIdOnChild: true }));
  const state = await readInternal<CorrelationTelemetryResponse>(
    service,
    "/internal/v1/correlations/order-42",
  );
  assert(state.firstReceivedAt !== null);
  assertEquals(state.traces.map((trace) => trace.traceId), [TRACE_ID]);
  assert(state.traces[0].rootSpanStoredAt !== null);

  const sessionState = await readInternal<SessionTelemetryResponse>(
    service,
    "/internal/v1/sessions/chat-7",
  );
  assertEquals(sessionState.firstReceivedAt, state.firstReceivedAt);
  const sessionSpans = await readInternal<CorrelationSpansResponse>(
    service,
    "/internal/v1/sessions/chat-7/spans",
  );
  assertEquals(sessionSpans.isTruncated, false);
  assert(sessionSpans.spans.length > 0);
  assert(sessionSpans.spans.every((span) => span.sessionId === "chat-7"));
  const otherProjectSpans = await readInternal<CorrelationSpansResponse>(
    service,
    "/internal/v1/sessions/chat-7/spans",
    "project-two",
  );
  assertEquals(otherProjectSpans.spans, []);
  const otherProjectState = await readInternal<CorrelationTelemetryResponse>(
    service,
    "/internal/v1/correlations/order-42",
    "project-two",
  );
  assertEquals(otherProjectState.traces, []);
});

defineTelemetryTest("reports a trace without its root span", async (service) => {
  const payload = createJsonTraceRequest({ includeCorrelationIdOnChild: true });
  payload.resourceSpans[0].scopeSpans[0].spans.shift();
  await postJsonTraces(service, payload);
  const state = await readInternal<CorrelationTelemetryResponse>(
    service,
    "/internal/v1/correlations/order-42",
  );
  assertEquals(state.traces, [{ traceId: TRACE_ID, rootSpanStoredAt: null }]);
});

defineTelemetryTest(
  "finds a Correlation ID with characters that need encoding",
  async (service) => {
    const correlationId = "order/42 and more";
    const payload = createJsonTraceRequest({ includeCorrelationIdOnChild: false });
    const [rootSpan] = payload.resourceSpans[0].scopeSpans[0].spans;
    rootSpan.attributes[0] = stringAttribute("correlation.id", correlationId);
    payload.resourceSpans[0].scopeSpans[0].spans.pop();
    await postJsonTraces(service, payload);
    const { spans } = await readInternal<CorrelationSpansResponse>(
      service,
      `/internal/v1/correlations/${encodeURIComponent(correlationId)}/spans`,
    );
    assertEquals(spans.map((span) => span.correlationId), [correlationId]);
  },
);

defineTelemetryTest("flags spans that arrive after their evaluation", async (service) => {
  const payload = createJsonTraceRequest({ includeCorrelationIdOnChild: true });
  const allSpans = payload.resourceSpans[0].scopeSpans[0].spans;
  const [rootSpan, childSpan] = allSpans;
  allSpans.splice(0, 2, rootSpan);
  await postJsonTraces(service, payload);
  const readTrace = async () =>
    await (await sendRequest(service, `/v1/traces/${TRACE_ID}`)).json() as TraceDetailResponse;
  assertEquals((await readTrace()).spans[0].arrivedAfterEvaluation, false);

  const evaluatedAt = new Date(Date.parse((await readTrace()).spans[0].receivedAt) + 1);
  await markEvaluated(service, "order-42", evaluatedAt);
  // A repeated job changes nothing: the first evaluation stays the cut-off.
  await markEvaluated(service, "order-42", new Date(evaluatedAt.getTime() + 3_600_000));

  // Exactly the stored time would not count as late, so the second batch waits past it.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  allSpans.splice(0, 1, childSpan);
  await postJsonTraces(service, payload);
  const { spans } = await readTrace();
  assertEquals(spans.map((span) => span.arrivedAfterEvaluation), [false, true]);
  assertEquals(
    (await readInternal<CorrelationSpansResponse>(
      service,
      "/internal/v1/correlations/order-42/spans",
    )).spans.map((span) => span.arrivedAfterEvaluation),
    [false, true],
  );
});

defineTelemetryTest("keeps its internal endpoints for services", async (service) => {
  const path = "/internal/v1/correlations/order-42";
  const userToken = await testAccessTokens.issueAccessToken({
    subject: "user:person",
    projectId: "project-one",
    role: "admin",
  });
  for (const apiKey of [API_KEY, userToken, "wrong-key"]) {
    const readResponse = await sendRequest(service, path, { apiKey });
    assertEquals(readResponse.status, 401);
    await readResponse.body?.cancel();
    const markResponse = await sendRequest(service, `${path}/evaluated`, {
      apiKey,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluatedAt: new Date().toISOString() }),
    });
    assertEquals(markResponse.status, 401);
    await markResponse.body?.cancel();
  }
});
