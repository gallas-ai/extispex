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
import { runWithTelemetryIds, TelemetryIdsSpanProcessor } from "@extispex/telemetry-ids";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
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

const tracerProvider = new TracerProvider({
  resource: resourceFromAttributes({ "service.name": "support-bot-example" }),
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

async function answerCustomer(customerMessage: string): Promise<string> {
  return await tracer.startActiveSpan("handle-message", async (rootSpan) => {
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
console.log(`Sent. Search for Session ID ${sessionId} in the UI.`);
