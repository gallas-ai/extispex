import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ListLogsResponse, LogRecord, RejectedTelemetry } from "@extispex/contracts";
import {
  runWithTelemetryIds,
  TelemetryIdsLogRecordProcessor,
  TelemetryIdsSpanProcessor,
} from "@extispex/telemetry-ids";
import * as grpc from "@grpc/grpc-js";
import { Buffer } from "node:buffer";
import { context, SeverityNumber } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter as GrpcLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as JsonLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as ProtobufLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { type RunningDeployment, startDeployment } from "./deployment.ts";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const E2E_SERVICE_NAME = "e2e-log-writer";

function createLoggerProvider(logExporter: LogRecordExporter): LoggerProvider {
  return new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": E2E_SERVICE_NAME }),
    processors: [
      new TelemetryIdsLogRecordProcessor(),
      new BatchLogRecordProcessor({ exporter: logExporter }),
    ],
  });
}

/** Logs from inside a span, as an application does while handling a request. */
async function sendLogInsideTrace(
  logExporter: LogRecordExporter,
  message: string,
  correlationId: string,
): Promise<{ traceId: string; spanId: string }> {
  const tracerProvider = new TracerProvider({ spanProcessors: [new TelemetryIdsSpanProcessor()] });
  const tracer = tracerProvider.getTracer("e2e");
  const loggerProvider = createLoggerProvider(logExporter);
  const logger = loggerProvider.getLogger("e2e");
  const spanContext = await runWithTelemetryIds(
    { correlationId, sessionId: `session-${correlationId}` },
    () =>
      tracer.startActiveSpan("handle-message", (span) => {
        logger.emit({
          severityNumber: SeverityNumber.ERROR,
          severityText: "ERROR",
          body: message,
          attributes: { "gen_ai.request.model": "model-one", attempt: 2 },
        });
        span.end();
        return span.spanContext();
      }),
  );
  await loggerProvider.forceFlush();
  await loggerProvider.shutdown();
  await tracerProvider.shutdown();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

async function queryLogs(deployment: RunningDeployment, query: string): Promise<LogRecord[]> {
  const response = await fetch(`${deployment.gatewayUrl}/v1/logs?${query}`, {
    headers: { authorization: `Bearer ${deployment.apiKey}` },
  });
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json() as ListLogsResponse).logs;
}

function createGrpcExporter(deployment: RunningDeployment): GrpcLogExporter {
  const grpcMetadata = new grpc.Metadata();
  grpcMetadata.set("authorization", `Bearer ${deployment.apiKey}`);
  const usesTls = deployment.grpcRootCertificate !== null;
  return new GrpcLogExporter({
    url: `${usesTls ? "https" : "http"}://${deployment.otlpGrpcAddress}`,
    credentials: usesTls
      ? grpc.credentials.createSsl(Buffer.from(deployment.grpcRootCertificate as Uint8Array))
      : grpc.credentials.createInsecure(),
    metadata: grpcMetadata,
  });
}

function uniqueWord(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

async function assertLogStored(
  deployment: RunningDeployment,
  word: string,
  identifiers: { traceId: string; spanId: string },
  correlationId: string,
): Promise<void> {
  const logs = await queryLogs(deployment, `search=${word}`);
  assertEquals(logs.length, 1, `expected one log record for ${word}`);
  assertEquals(logs[0].body, `Payment failed with code ${word}`);
  assertEquals(logs[0].severity, "error");
  assertEquals(logs[0].traceId, identifiers.traceId);
  assertEquals(logs[0].spanId, identifiers.spanId);
  assertEquals(logs[0].correlationId, correlationId);
  assertEquals(logs[0].serviceName, E2E_SERVICE_NAME);
  assertEquals(logs[0].attributes["gen_ai.request.model"], "model-one");
  assertEquals(logs[0].attributes["session.id"], `session-${correlationId}`);
}

Deno.test("log pipeline", async (testContext) => {
  const deployment = await startDeployment();
  const authorizationHeaders = { authorization: `Bearer ${deployment.apiKey}` };
  const sendRawJsonLogs = (payload: unknown) =>
    fetch(`${deployment.otlpHttpUrl}/v1/logs`, {
      method: "POST",
      headers: { ...authorizationHeaders, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  try {
    const exportersByName: [string, () => LogRecordExporter][] = [
      [
        "OTLP/HTTP protobuf",
        () =>
          new ProtobufLogExporter({
            url: `${deployment.otlpHttpUrl}/v1/logs`,
            headers: authorizationHeaders,
          }),
      ],
      [
        "OTLP/HTTP JSON",
        () =>
          new JsonLogExporter({
            url: `${deployment.otlpHttpUrl}/v1/logs`,
            headers: authorizationHeaders,
          }),
      ],
      [
        "OTLP/HTTP protobuf with gzip",
        () =>
          new ProtobufLogExporter({
            url: `${deployment.otlpHttpUrl}/v1/logs`,
            headers: authorizationHeaders,
            compression: CompressionAlgorithm.GZIP,
          }),
      ],
      ["OTLP/gRPC", () => createGrpcExporter(deployment)],
    ];

    for (const [exporterName, createExporter] of exportersByName) {
      await testContext.step(`finds a log sent over ${exporterName} by a word`, async () => {
        const word = uniqueWord("code");
        const correlationId = crypto.randomUUID();
        const identifiers = await sendLogInsideTrace(
          createExporter(),
          `Payment failed with code ${word}`,
          correlationId,
        );
        await assertLogStored(deployment, word, identifiers, correlationId);
      });
    }

    await testContext.step("filters by time range, severity, attribute and trace", async () => {
      const word = uniqueWord("filter");
      const correlationId = crypto.randomUUID();
      const { traceId } = await sendLogInsideTrace(
        new JsonLogExporter({
          url: `${deployment.otlpHttpUrl}/v1/logs`,
          headers: authorizationHeaders,
        }),
        `Filtered ${word}`,
        correlationId,
      );
      const found = async (extraQuery: string) =>
        (await queryLogs(deployment, `search=${word}&${extraQuery}`)).length;
      const minutesFromNow = (minutes: number) =>
        encodeURIComponent(new Date(Date.now() + minutes * 60_000).toISOString());
      assertEquals(await found(`from=${minutesFromNow(-5)}&to=${minutesFromNow(5)}`), 1);
      assertEquals(await found(`to=${minutesFromNow(-5)}`), 0);
      assertEquals(await found("minimumSeverity=fatal"), 0);
      assertEquals(await found("minimumSeverity=warn"), 1);
      assertEquals(await found("attribute=attempt%3D2"), 1);
      assertEquals(await found("attribute=gen_ai.request.model%3Dmodel-two"), 0);
      assertEquals(await found(`traceId=${traceId}`), 1);
      assertEquals(await found(`correlationId=${correlationId}`), 1);
    });

    await testContext.step("stores a log without a trace as uncorrelated", async () => {
      const word = uniqueWord("startup");
      const loggerProvider = createLoggerProvider(
        new JsonLogExporter({
          url: `${deployment.otlpHttpUrl}/v1/logs`,
          headers: authorizationHeaders,
        }),
      );
      loggerProvider.getLogger("e2e").emit({
        severityNumber: SeverityNumber.INFO,
        body: `Service started ${word}`,
      });
      await loggerProvider.forceFlush();
      await loggerProvider.shutdown();

      const logs = await queryLogs(deployment, `search=${word}`);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].traceId, null);
      assertEquals(logs[0].correlationId, null);
    });

    await testContext.step("rejects a log of a trace without a Correlation ID", async () => {
      const word = uniqueWord("rejected");
      const nowNanoseconds = `${BigInt(Date.now()) * 1_000_000n}`;
      const response = await sendRawJsonLogs({
        resourceLogs: [{
          scopeLogs: [{
            logRecords: [{
              timeUnixNano: nowNanoseconds,
              traceId: "5b8efff798038103d269b633813fc60c",
              body: { stringValue: word },
            }],
          }],
        }],
      });
      assertEquals(response.status, 200);
      const { partialSuccess } = await response.json();
      assertEquals(partialSuccess.rejectedLogRecords, 1);
      assertStringIncludes(partialSuccess.errorMessage, "correlation.id");
      assertEquals(await queryLogs(deployment, `search=${word}`), []);
    });

    await testContext.step(
      "counts rejected spans and log records through the Gateway",
      async () => {
        const spanResponse = await fetch(`${deployment.otlpHttpUrl}/v1/traces`, {
          method: "POST",
          headers: { ...authorizationHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            resourceSpans: [{
              scopeSpans: [{
                spans: [{
                  traceId: "5b8efff798038103d269b633813fc60c",
                  spanId: "eee19b7ec3c1b174",
                  name: "without-correlation",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000250000000",
                }],
              }],
            }],
          }),
        });
        await spanResponse.body?.cancel();

        const response = await fetch(`${deployment.gatewayUrl}/v1/rejected-telemetry`, {
          headers: authorizationHeaders,
        });
        assertEquals(response.status, 200);
        const counts = await response.json() as RejectedTelemetry;
        assert(counts.logs.rejectedCount >= 1);
        assertStringIncludes(counts.logs.lastReason ?? "", "correlation.id");
        assert(counts.spans.rejectedCount >= 1);
      },
    );

    await testContext.step("does not take OTLP logs through the Gateway", async () => {
      const response = await fetch(`${deployment.gatewayUrl}/v1/logs`, {
        method: "POST",
        headers: { ...authorizationHeaders, "content-type": "application/json" },
        body: "{}",
      });
      assertEquals(response.status, 404);
      await response.body?.cancel();
    });

    await testContext.step("lists the log endpoints in the combined OpenAPI document", async () => {
      const response = await fetch(`${deployment.gatewayUrl}/v1/openapi.json`);
      const { paths } = await response.json();
      assert("/v1/logs" in paths);
      assert("/v1/rejected-telemetry" in paths);
      assertEquals(Object.keys(paths["/v1/logs"]), ["get"]);
    });
  } finally {
    await deployment.stop();
  }
});
