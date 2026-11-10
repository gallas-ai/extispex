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
      identity: unexpectedServiceCall(),
      evaluation: unexpectedServiceCall(),
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
  assertEquals(receivedRequests[0].headers.get("x-forwarded-proto"), "http");
});

Deno.test("forwards prompt requests with their body to the Prompt service", async () => {
  const receivedRequests: Request[] = [];
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: recordingServiceClient(receivedRequests),
      identity: unexpectedServiceCall(),
      evaluation: unexpectedServiceCall(),
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
      identity: () => Promise.reject(new TypeError("connection refused")),
      evaluation: unexpectedServiceCall(),
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

Deno.test("forwards Project management with the access token to the Identity service", async () => {
  const receivedRequests: Request[] = [];
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: unexpectedServiceCall(),
      identity: recordingServiceClient(receivedRequests),
      evaluation: unexpectedServiceCall(),
    },
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/projects/project-one/api-keys/key-one", {
      method: "DELETE",
      headers: { authorization: "Bearer access-token" },
    }),
  );
  await response.body?.cancel();

  assertEquals(response.status, 200);
  assertEquals(receivedRequests[0].method, "DELETE");
  assertEquals(
    new URL(receivedRequests[0].url).pathname,
    "/v1/projects/project-one/api-keys/key-one",
  );
  assertEquals(receivedRequests[0].headers.get("authorization"), "Bearer access-token");
});

Deno.test("forwards a directory's SCIM requests to Identity", async () => {
  const receivedRequests: Request[] = [];
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: unexpectedServiceCall(),
      identity: recordingServiceClient(receivedRequests),
      evaluation: unexpectedServiceCall(),
    },
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/scim/v2/Users/user-one", {
      method: "PATCH",
      headers: {
        authorization: "Bearer directory-token",
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({ Operations: [{ op: "replace", path: "active", value: false }] }),
    }),
  );
  await response.body?.cancel();

  assertEquals(response.status, 200);
  assertEquals(new URL(receivedRequests[0].url).pathname, "/scim/v2/Users/user-one");
  assertEquals(receivedRequests[0].headers.get("authorization"), "Bearer directory-token");
  assertEquals(receivedRequests[0].headers.get("content-type"), "application/scim+json");
});

Deno.test("passes the sign-in cookie between the browser and Identity", async () => {
  const receivedRequests: Request[] = [];
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: unexpectedServiceCall(),
      identity: (request) => {
        receivedRequests.push(request);
        return Promise.resolve(
          Response.json({ accessToken: "token" }, {
            headers: { "set-cookie": "extispex_sign_in=renewed; Path=/v1/sign-in; HttpOnly" },
          }),
        );
      },
      evaluation: unexpectedServiceCall(),
    },
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/sign-in/access-tokens", {
      method: "POST",
      headers: {
        cookie: "extispex_sign_in=current",
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: "{}",
    }),
  );
  await response.body?.cancel();

  assertEquals(receivedRequests[0].headers.get("cookie"), "extispex_sign_in=current");
  assertEquals(receivedRequests[0].headers.get("x-forwarded-proto"), "https");
  assertEquals(
    response.headers.get("set-cookie"),
    "extispex_sign_in=renewed; Path=/v1/sign-in; HttpOnly",
  );
});

Deno.test("does not expose the internal API key resolution through the gateway", async () => {
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: unexpectedServiceCall(),
      identity: unexpectedServiceCall(),
      evaluation: unexpectedServiceCall(),
    },
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/internal/v1/api-keys/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "guessed-key" }),
    }),
  );

  assertEquals(response.status, 404);
  await response.body?.cancel();
});

Deno.test("does not expose OTLP ingestion through the gateway", async () => {
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: unexpectedServiceCall(),
      identity: unexpectedServiceCall(),
      evaluation: unexpectedServiceCall(),
    },
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
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: unexpectedServiceCall(),
      identity: unexpectedServiceCall(),
      evaluation: unexpectedServiceCall(),
    },
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
      "/v1/logs",
      "/v1/rejected-telemetry",
      "/v1/prompts",
      "/v1/prompts/{promptName}/versions/{versionNumber}",
      "/v1/prompts/{promptName}/labels/{labelName}",
      "/v1/prompts/{promptName}/compare",
      "/v1/projects",
      "/v1/projects/{projectId}/api-keys",
      "/v1/projects/{projectId}/api-keys/{apiKeyId}",
      "/v1/projects/{projectId}/role-assignments/{groupId}",
      "/v1/sign-in",
      "/v1/sign-in/access-tokens",
      "/v1/users/{userId}",
      "/v1/groups/{groupId}/members/{userId}",
      "/v1/directory/imports",
      "/scim/v2/Users",
      "/scim/v2/Groups/{resourceId}",
    ]
  ) {
    assert(documentedPaths.includes(expectedPath), `${expectedPath} is not documented.`);
  }
  assertEquals(Object.keys(openApiDocument.paths["/v1/prompts/{promptName}/labels/{labelName}"]), [
    "get",
    "put",
    "delete",
  ]);
  assertEquals(Object.keys(openApiDocument.components.securitySchemes), [
    "apiKey",
    "accessToken",
    "serviceClient",
    "directoryToken",
  ]);
  assertEquals(openApiDocument.paths["/v1/projects"].post.security, [{ accessToken: [] }]);
  assertEquals(openApiDocument.paths["/v1/prompts"].get.security, [
    { apiKey: [] },
    { accessToken: [] },
  ]);
  assert(!documentedPaths.some((path) => path.startsWith("/internal/")));
});

Deno.test("turns OpenAPI path parameters into Hono path parameters", () => {
  assertEquals(
    convertOpenApiPathToHonoPath("/v1/prompts/{promptName}/versions/{versionNumber}"),
    "/v1/prompts/:promptName/versions/:versionNumber",
  );
});

Deno.test("tells Identity the browser's address, which a client cannot choose", async () => {
  const forwardedAddresses: (string | null)[] = [];
  const createGatewayWithProxies = (trustedProxyCount: number) =>
    createGatewayService({
      serviceClients: {
        telemetry: unexpectedServiceCall(),
        prompt: unexpectedServiceCall(),
        identity: (request) => {
          forwardedAddresses.push(request.headers.get("x-forwarded-for"));
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        evaluation: unexpectedServiceCall(),
      },
      webAssetsDirectory: null,
      trustedProxyCount,
      logger,
    });
  const sendFromPeer = async (trustedProxyCount: number) => {
    const response = await createGatewayWithProxies(trustedProxyCount).handleRequest(
      new Request("http://gateway.test/v1/sign-in", {
        method: "DELETE",
        headers: { "x-forwarded-for": "198.51.100.66, 203.0.113.7" },
      }),
      { remoteAddr: { hostname: "10.0.0.5" } },
    );
    await response.body?.cancel();
  };

  await sendFromPeer(0);
  await sendFromPeer(1);
  await sendFromPeer(2);
  await sendFromPeer(3);

  assertEquals(forwardedAddresses, ["10.0.0.5", "203.0.113.7", "198.51.100.66", "10.0.0.5"]);
});

Deno.test("passes redirects to the browser instead of following them", async () => {
  let forwardedRedirectMode: string | null = null;
  const gatewayService = createGatewayService({
    serviceClients: {
      telemetry: unexpectedServiceCall(),
      prompt: unexpectedServiceCall(),
      identity: (request) => {
        forwardedRedirectMode = request.redirect;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://idp.example.test/authorize" },
          }),
        );
      },
      evaluation: unexpectedServiceCall(),
    },
    webAssetsDirectory: null,
    logger,
  });

  const response = await gatewayService.handleRequest(
    new Request("http://gateway.test/v1/sign-in/oidc/authorize?returnTo=%2Ftraces"),
  );

  assertEquals(response.status, 302);
  assertEquals(response.headers.get("location"), "https://idp.example.test/authorize");
  assertEquals(forwardedRedirectMode, "manual");
});
