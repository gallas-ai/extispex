import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ListTracesResponse, TraceDetailResponse } from "@evaluation-telemetry/contracts";
import {
  runWithTelemetryIds,
  TelemetryIdsSpanProcessor,
} from "@evaluation-telemetry/telemetry-ids";
import * as grpc from "@grpc/grpc-js";
import { Buffer } from "node:buffer";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtobufTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { type RunningDeployment, startDeployment } from "./deployment.ts";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

/** Sends one conversation step as a real application would: a root span with two children. */
async function sendConversationStep(
  spanExporter: SpanExporter,
  telemetryIds: { correlationId: string; sessionId: string },
): Promise<void> {
  const tracerProvider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "e2e-support-bot" }),
    spanProcessors: [
      new TelemetryIdsSpanProcessor(),
      new BatchSpanProcessor({ exporter: spanExporter }),
    ],
  });
  const tracer = tracerProvider.getTracer("e2e");
  await runWithTelemetryIds(
    telemetryIds,
    () =>
      tracer.startActiveSpan("handle-message", async (rootSpan) => {
        await tracer.startActiveSpan("chat model-one", (llmSpan) => {
          llmSpan.setAttribute("gen_ai.request.model", "model-one");
          llmSpan.end();
        });
        await tracer.startActiveSpan("tool find_order", (toolSpan) => toolSpan.end());
        rootSpan.end();
      }),
  );
  await tracerProvider.forceFlush();
  await tracerProvider.shutdown();
}

async function queryGateway<ResponseBody>(
  deployment: RunningDeployment,
  path: string,
): Promise<ResponseBody> {
  const response = await fetch(`${deployment.gatewayUrl}${path}`, {
    headers: { authorization: `Bearer ${deployment.apiKey}` },
  });
  assertEquals(response.status, 200, `GET ${path} failed: ${await response.clone().text()}`);
  return await response.json() as ResponseBody;
}

async function assertConversationStepStored(deployment: RunningDeployment, correlationId: string) {
  const { traces } = await queryGateway<ListTracesResponse>(
    deployment,
    `/v1/traces?correlationId=${correlationId}`,
  );
  assertEquals(traces.length, 1, `expected one trace for ${correlationId}`);
  assertEquals(traces[0].rootSpanName, "handle-message");
  assertEquals(traces[0].serviceName, "e2e-support-bot");
  assertEquals(traces[0].spanCount, 3);
  assert(traces[0].hasRootSpan);

  const traceDetail = await queryGateway<TraceDetailResponse>(
    deployment,
    `/v1/traces/${traces[0].traceId}`,
  );
  const llmSpan = traceDetail.spans.find((span) => span.name === "chat model-one");
  assertEquals(llmSpan?.attributes["gen_ai.request.model"], "model-one");
  assertEquals(llmSpan?.correlationId, correlationId);
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

Deno.test("trace pipeline", async (testContext) => {
  const deployment = await startDeployment();
  const authorizationHeaders = { authorization: `Bearer ${deployment.apiKey}` };
  try {
    await testContext.step("stores spans sent over OTLP/HTTP protobuf", async () => {
      const correlationId = uniqueId("protobuf");
      await sendConversationStep(
        new ProtobufTraceExporter({
          url: `${deployment.otlpHttpUrl}/v1/traces`,
          headers: authorizationHeaders,
        }),
        { correlationId, sessionId: uniqueId("session") },
      );
      await assertConversationStepStored(deployment, correlationId);
    });

    await testContext.step("stores spans sent over OTLP/HTTP JSON", async () => {
      const correlationId = uniqueId("json");
      await sendConversationStep(
        new JsonTraceExporter({
          url: `${deployment.otlpHttpUrl}/v1/traces`,
          headers: authorizationHeaders,
        }),
        { correlationId, sessionId: uniqueId("session") },
      );
      await assertConversationStepStored(deployment, correlationId);
    });

    await testContext.step("stores spans sent over OTLP/gRPC", async () => {
      const correlationId = uniqueId("grpc");
      const grpcMetadata = new grpc.Metadata();
      grpcMetadata.set("authorization", `Bearer ${deployment.apiKey}`);
      const usesTls = deployment.grpcRootCertificate !== null;
      await sendConversationStep(
        new GrpcTraceExporter({
          url: `${usesTls ? "https" : "http"}://${deployment.otlpGrpcAddress}`,
          credentials: usesTls
            ? grpc.credentials.createSsl(Buffer.from(deployment.grpcRootCertificate as Uint8Array))
            : grpc.credentials.createInsecure(),
          metadata: grpcMetadata,
        }),
        { correlationId, sessionId: uniqueId("session") },
      );
      await assertConversationStepStored(deployment, correlationId);
    });

    await testContext.step("groups the traces of one Session", async () => {
      const sessionId = uniqueId("session");
      const exporter = () =>
        new ProtobufTraceExporter({
          url: `${deployment.otlpHttpUrl}/v1/traces`,
          headers: authorizationHeaders,
        });
      await sendConversationStep(exporter(), { correlationId: uniqueId("turn-1"), sessionId });
      await sendConversationStep(exporter(), { correlationId: uniqueId("turn-2"), sessionId });
      const { traces } = await queryGateway<ListTracesResponse>(
        deployment,
        `/v1/traces?sessionId=${sessionId}`,
      );
      assertEquals(traces.length, 2);
    });

    await testContext.step("rejects spans without a Correlation ID", async () => {
      const response = await fetch(`${deployment.otlpHttpUrl}/v1/traces`, {
        method: "POST",
        headers: { ...authorizationHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [{
            scopeSpans: [{
              spans: [{
                traceId: crypto.randomUUID().replaceAll("-", ""),
                spanId: "1111111111111111",
                name: "GET /health",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000100000000",
              }],
            }],
          }],
        }),
      });
      const responseBody = await response.json();
      assertEquals(response.status, 200);
      assertEquals(responseBody.partialSuccess.rejectedSpans, 1);
      assertStringIncludes(responseBody.partialSuccess.errorMessage, "correlation.id");
    });

    await testContext.step("refuses OTLP data without a valid API key", async () => {
      const response = await fetch(`${deployment.otlpHttpUrl}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
        body: "{}",
      });
      assertEquals(response.status, 401);
      await response.body?.cancel();
    });

    await testContext.step(
      "serves the web UI and falls back to it for browser routes",
      async () => {
        for (const path of ["/", "/traces/some-trace"]) {
          const response = await fetch(`${deployment.gatewayUrl}${path}`);
          assertEquals(response.status, 200);
          assertStringIncludes(await response.text(), '<div id="root"></div>');
        }
      },
    );

    await testContext.step("publishes the API description through the gateway", async () => {
      const openApiDocument = await queryGateway<{ openapi: string }>(
        deployment,
        "/v1/openapi.json",
      );
      assertEquals(openApiDocument.openapi, "3.1.0");
    });
  } finally {
    await deployment.stop();
  }
});
