import { assert, assertEquals } from "@std/assert";
import { createStructuredLogger } from "@extispex/service-runtime";
import type { ServiceClient } from "@extispex/service-client";
import { convertOpenApiPathToHonoPath, createGatewayService } from "../src/create-service.ts";

const logger = createStructuredLogger("gateway-test");

function unexpectedServiceCall(): ServiceClient {
  return () => Promise.reject(new Error("This service should not be called."));
}

function recordingServiceClient(
  receivedRequests: Request[],
  responseBody: unknown = {},
): ServiceClient {
  return (request) => {
    receivedRequests.push(request);
    return Promise.resolve(Response.json(responseBody));
  };
}

Deno.test("forwards trace queries with only the allowed headers", async () => {
  const receivedRequests: Request[] = [];
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: recordingServiceClient(receivedRequests, { traces: [] }),
      prompt: unexpectedServiceCall(),
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

Deno.test("forwards prompt requests with their body to the Prompt service", async () => {
  const receivedRequests: Request[] = [];
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: recordingServiceClient(receivedRequests),
    },
    webAssetsDirectory: null,
    logger,
  });
  const requestBody = JSON.stringify({ versionNumber: 3 });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/prompts/support-agent/labels/production", {
      method: "PUT",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: requestBody,
    }),
  );
  await response.body?.cancel();

  assertEquals(response.status, 200);
  assertEquals(receivedRequests[0].method, "PUT");
  assertEquals(
    new URL(receivedRequests[0].url).pathname,
    "/v1/prompts/support-agent/labels/production",
  );
  assertEquals(receivedRequests[0].headers.get("content-type"), "application/json");
  assertEquals(await receivedRequests[0].text(), requestBody);
});

Deno.test("answers 503 when a service is unreachable", async () => {
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: () => Promise.reject(new TypeError("connection refused")),
      prompt: () => Promise.reject(new TypeError("connection refused")),
    },
    webAssetsDirectory: null,
    logger: { ...logger, error: () => {} },
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/prompts"),
  );

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error: { code: "service_unavailable", message: "The Prompt service is unavailable." },
  });
});

Deno.test("does not expose OTLP ingestion through the gateway", async () => {
  const gatewayService = createGatewayService({
    serviceClients: { telemetry: unexpectedServiceCall(), prompt: unexpectedServiceCall() },
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/traces", { method: "POST", body: "{}" }),
  );

  assertEquals(response.status, 404);
  await response.body?.cancel();
});

Deno.test("publishes one OpenAPI document for every service", async () => {
  const gatewayService = createGatewayService({
    serviceClients: { telemetry: unexpectedServiceCall(), prompt: unexpectedServiceCall() },
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/openapi.json"),
  );
  const openApiDocument = await response.json();

  assertEquals(openApiDocument.openapi, "3.1.0");
  assertEquals(openApiDocument.info.title, "Extispex API");
  const documentedPaths = Object.keys(openApiDocument.paths);
  for (
    const expectedPath of [
      "/v1/traces",
      "/v1/traces/{traceId}",
      "/v1/prompts",
      "/v1/prompts/{promptName}/versions/{versionNumber}",
      "/v1/prompts/{promptName}/labels/{labelName}",
      "/v1/prompts/{promptName}/compare",
    ]
  ) {
    assert(documentedPaths.includes(expectedPath), `${expectedPath} is not documented.`);
  }
  assertEquals(Object.keys(openApiDocument.paths["/v1/prompts/{promptName}/labels/{labelName}"]), [
    "get",
    "put",
    "delete",
  ]);
  assertEquals(Object.keys(openApiDocument.components.securitySchemes), ["apiKey"]);
});

Deno.test("turns OpenAPI path parameters into Hono path parameters", () => {
  assertEquals(
    convertOpenApiPathToHonoPath("/v1/prompts/{promptName}/versions/{versionNumber}"),
    "/v1/prompts/:promptName/versions/:versionNumber",
  );
});
