/**
 * A sample Target: a support bot that Server-Driven Execution calls for each step of an Iteration.
 *
 *     API_KEY=<your Project API key> deno task sample-target
 *
 * It answers `POST /evaluate` with the contract every Target follows:
 *
 *     request   {"input": {"message": "Where is my order?"}, "sessionId": null}
 *     response  {"output": "It ships today.", "correlationId": "…", "sessionId": "…"}
 *
 * The application assigns both IDs, as it does in production, and puts them on its spans. The
 * first step has no `sessionId`; the platform sends back the one this Target returned.
 *
 * Environment: API_KEY (required), the key of the Project to send telemetry to; OTLP_HTTP_URL
 * (default http://127.0.0.1:4318); PORT (default 8090); TARGET_TOKEN, which callers must send as
 * `Authorization: Bearer <token>` when it is set. Create the Target in the UI under Targets with
 * the URL http://127.0.0.1:8090/evaluate.
 */
import { runWithTelemetryIds, TelemetryIdsSpanProcessor } from "@extispex/telemetry-ids";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const otlpHttpUrl = Deno.env.get("OTLP_HTTP_URL") ?? "http://127.0.0.1:4318";
const apiKey = Deno.env.get("API_KEY");
const port = Number(Deno.env.get("PORT") ?? "8090");
const targetToken = Deno.env.get("TARGET_TOKEN");
if (!apiKey) {
  console.error("Set API_KEY to the API key of the Project that receives the telemetry.");
  Deno.exit(2);
}

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const tracerProvider = new TracerProvider({
  resource: resourceFromAttributes({ "service.name": "sample-target" }),
  spanProcessors: [
    new TelemetryIdsSpanProcessor(),
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter({
        url: `${otlpHttpUrl}/v1/traces`,
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    }),
  ],
});
const tracer = tracerProvider.getTracer("sample-target");

/** Stands in for an LLM with tools: finding an order and cancelling it. */
async function answerCustomer(message: string): Promise<string> {
  return await tracer.startActiveSpan("handle-message", async (rootSpan) => {
    const wantsToCancel = /cancel/i.test(message);
    const toolName = wantsToCancel ? "cancel_order" : "lookup_order";
    await tracer.startActiveSpan("execute_tool", (toolSpan) => {
      toolSpan.setAttribute("gen_ai.tool.name", toolName);
      toolSpan.end();
    });
    rootSpan.end();
    return wantsToCancel
      ? "Your order is cancelled. The refund arrives within 30 days."
      : "Your order ships today.";
  });
}

function readMessage(input: unknown): string {
  if (typeof input === "string") return input;
  const message = (input as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : JSON.stringify(input);
}

Deno.serve(
  { port, onListen: () => console.log(`Sample Target listening on port ${port}`) },
  async (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return new Response("ok");
    if (request.method !== "POST" || pathname !== "/evaluate") {
      return new Response("Not found", { status: 404 });
    }
    if (
      targetToken !== undefined && request.headers.get("authorization") !== `Bearer ${targetToken}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    const { input, sessionId } = await request.json() as {
      input: unknown;
      sessionId: string | null;
    };
    const correlationId = crypto.randomUUID();
    const sessionIdToUse = sessionId ?? `sample-session-${crypto.randomUUID()}`;
    const output = await runWithTelemetryIds(
      { correlationId, sessionId: sessionIdToUse },
      () => answerCustomer(readMessage(input)),
    );
    // A real application leaves this to the batch processor. The sample sends its spans before it
    // answers, so that a run against it does not wait for the next export.
    await tracerProvider.forceFlush();
    return Response.json({ output, correlationId, sessionId: sessionIdToUse });
  },
);
