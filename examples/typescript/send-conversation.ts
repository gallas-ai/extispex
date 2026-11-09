/**
 * Sends a two-step support conversation as an instrumented application would.
 *
 * Each step gets its own Correlation ID; both steps share one Session ID. The application owns
 * both values: the platform never generates them.
 *
 *   API_KEY=<your Project API key> deno task send-conversation
 *
 * Environment: API_KEY (required), the key of the Project to send to, and OTLP_HTTP_URL (default
 * http://127.0.0.1:4318).
 */
import {
  runWithTelemetryIds,
  TelemetryIdsLogRecordProcessor,
  TelemetryIdsSpanProcessor,
} from "@extispex/telemetry-ids";
import { context, SeverityNumber } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const otlpHttpUrl = Deno.env.get("OTLP_HTTP_URL") ?? "http://127.0.0.1:4318";
const apiKey = Deno.env.get("API_KEY");
if (!apiKey) {
  console.error(
    "Set API_KEY to a Project API key. A new instance logs the key of its first Project on first " +
      "start; more keys are created under Projects in the UI.",
  );
  Deno.exit(1);
}

// Baggage only flows between spans when a context manager is registered.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const resource = resourceFromAttributes({ "service.name": "support-bot-example" });
const tracerProvider = new TracerProvider({
  resource,
  spanProcessors: [
    // Copies the IDs onto every span. It must run before the exporting processor.
    new TelemetryIdsSpanProcessor(),
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter({
        url: `${otlpHttpUrl}/v1/traces`,
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    }),
  ],
});
const tracer = tracerProvider.getTracer("support-bot-example");

const loggerProvider = new LoggerProvider({
  resource,
  processors: [
    // Copies the IDs onto every log record. It must run before the exporting processor.
    new TelemetryIdsLogRecordProcessor(),
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({
        url: `${otlpHttpUrl}/v1/logs`,
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    }),
  ],
});
const logger = loggerProvider.getLogger("support-bot-example");

async function answerCustomer(customerMessage: string): Promise<string> {
  return await tracer.startActiveSpan("handle-message", async (rootSpan) => {
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: `Received: ${customerMessage}`,
    });
    const answer = await tracer.startActiveSpan("chat example-model", (llmSpan) => {
      llmSpan.setAttribute("gen_ai.request.model", "example-model");
      llmSpan.end();
      return `Answer to: ${customerMessage}`;
    });
    await tracer.startActiveSpan("tool find_order", (toolSpan) => toolSpan.end());
    rootSpan.end();
    return answer;
  });
}

const sessionId = `support-chat-${crypto.randomUUID()}`;
for (const customerMessage of ["Where is my order?", "Can I cancel it?"]) {
  const correlationId = crypto.randomUUID();
  const answer = await runWithTelemetryIds(
    { correlationId, sessionId },
    () => answerCustomer(customerMessage),
  );
  console.log(`${answer} (Correlation ID ${correlationId})`);
}

await tracerProvider.forceFlush();
await tracerProvider.shutdown();
await loggerProvider.forceFlush();
await loggerProvider.shutdown();
console.log(`Sent. Search for Session ID ${sessionId} in the UI.`);
