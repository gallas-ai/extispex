import { assertEquals } from "@std/assert";
import { createStructuredLogger } from "@extispex/service-runtime";
import { createGatewayService } from "../src/create-service.ts";

const logger = createStructuredLogger("gateway-test");

Deno.test("forwards trace queries with only the allowed headers", async () => {
  const receivedRequests: Request[] = [];
  const gatewayService = createGatewayService({
    telemetryClient: (request) => {
      receivedRequests.push(request);
      return Promise.resolve(Response.json({ traces: [] }));
    },
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/traces?correlationId=order-42", {
      headers: { authorization: "Bearer test-key", cookie: "session=secret" },
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { traces: [] });
  assertEquals(new URL(receivedRequests[0].url).search, "?correlationId=order-42");
  assertEquals(receivedRequests[0].headers.get("authorization"), "Bearer test-key");
  assertEquals(receivedRequests[0].headers.get("cookie"), null);
});

Deno.test("answers 503 when the Telemetry service is unreachable", async () => {
  const gatewayService = createGatewayService({
    telemetryClient: () => Promise.reject(new TypeError("connection refused")),
    webAssetsDirectory: null,
    logger: { ...logger, error: () => {} },
  });

  const response = await gatewayService.handleRequest(new Request("http://gateway.test/v1/traces"));

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error.code, "service_unavailable");
});

Deno.test("does not expose OTLP ingestion through the gateway", async () => {
  const gatewayService = createGatewayService({
    telemetryClient: () => Promise.resolve(new Response("unexpected")),
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/traces", { method: "POST", body: "{}" }),
  );

  assertEquals(response.status, 404);
  await response.body?.cancel();
});
