import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseDestinationAllowlist } from "../src/targets/destination-allowlist.ts";
import { parseProxyRouting } from "../src/targets/proxy-settings.ts";
import {
  createTargetClient,
  type ResolvedAddress,
  type TargetCallResult,
} from "../src/targets/target-client.ts";
import { startTestProxy } from "./fixtures/test-proxy.ts";

interface ReceivedCall {
  host: string | null;
  authorization: string | null;
  body: unknown;
}

/** A local Target; each test says how it answers. */
async function withTarget(
  answer: (request: Request) => Response | Promise<Response>,
  testBody: (port: number, receivedCalls: ReceivedCall[]) => Promise<void>,
) {
  const receivedCalls: ReceivedCall[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const body = await request.json();
      receivedCalls.push({
        host: request.headers.get("host"),
        authorization: request.headers.get("authorization"),
        body,
      });
      return await answer(new Request(request.url, { method: "POST", body: JSON.stringify(body) }));
    },
  );
  try {
    await testBody(server.addr.port, receivedCalls);
  } finally {
    await server.shutdown();
  }
}

const ANSWER = { output: "Refunds within 30 days.", correlationId: "c-1", sessionId: "chat-42" };

function callOnce(
  port: number,
  options: { allowedDestinations?: string; resolve?: (hostName: string) => ResolvedAddress[] } = {},
  hostName = "127.0.0.1",
): Promise<TargetCallResult> {
  const client = createTargetClient({
    allowlist: parseDestinationAllowlist(options.allowedDestinations ?? "127.0.0.1"),
    timeoutMilliseconds: 1_000,
    resolveHostAddresses: options.resolve === undefined
      ? undefined
      : (requestedHost) => Promise.resolve(options.resolve!(requestedHost)),
  });
  return client.callTarget(
    {
      url: `http://${hostName}:${port}/evaluate`,
      credential: { headerName: "Authorization", headerValue: "Bearer target-secret" },
    },
    { input: { message: "Where is my order?" }, sessionId: null },
  );
}

Deno.test("sends the input with the credential and reads the answer", async () => {
  await withTarget(() => Response.json(ANSWER), async (port, receivedCalls) => {
    assertEquals(await callOnce(port), { status: "answered", ...ANSWER });
    assertEquals(receivedCalls, [{
      host: `127.0.0.1:${port}`,
      authorization: "Bearer target-secret",
      body: { input: { message: "Where is my order?" }, sessionId: null },
    }]);
  });
});

Deno.test("connects to the checked address and keeps the host name", async () => {
  await withTarget(() => Response.json(ANSWER), async (port, receivedCalls) => {
    const lookups: string[] = [];
    const result = await callOnce(port, {
      allowedDestinations: "agent.company.example, 127.0.0.0/8",
      resolve: (hostName) => {
        lookups.push(hostName);
        return [{ address: "127.0.0.1", family: 4 }];
      },
    }, "agent.company.example");
    assertEquals(result.status, "answered");
    assertEquals(lookups, ["agent.company.example"]);
    assertEquals(receivedCalls[0].host, `agent.company.example:${port}`);
  });
});

Deno.test("refuses a name that now resolves to a protected address", async () => {
  await withTarget(() => Response.json(ANSWER), async (port, receivedCalls) => {
    // DNS rebinding: the name first resolves to an allowed address, then to the machine itself.
    const answers = [["10.20.0.5"], ["127.0.0.1"]];
    const options = {
      allowedDestinations: "agent.company.example",
      resolve: () => answers.shift()!.map((address) => ({ address, family: 4 })),
    };
    const first = await callOnce(port, options, "agent.company.example");
    // 10.20.0.5 is allowed but not reachable here; what matters is that it was not refused.
    assertEquals(first.status, "error");
    assertEquals(
      (first as { reason: string }).reason.includes("not allowed"),
      false,
      "The first address is allowed.",
    );
    const second = await callOnce(port, options, "agent.company.example");
    assertStringIncludes((second as { reason: string }).reason, "not allowed");
    assertEquals(receivedCalls, []);
  });
});

Deno.test("refuses an address outside the list before connecting", async () => {
  await withTarget(() => Response.json(ANSWER), async (port, receivedCalls) => {
    const result = await callOnce(port, { allowedDestinations: "agent.company.example" });
    assertStringIncludes((result as { reason: string }).reason, "not allowed");
    assertEquals(receivedCalls, []);
  });
});

Deno.test("does not follow a redirect", async () => {
  await withTarget(
    () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    async (port) => {
      const result = await callOnce(port);
      assertStringIncludes((result as { reason: string }).reason, "redirect (302)");
    },
  );
});

Deno.test("turns every other problem into a reason", async () => {
  const cases: Array<[() => Response | Promise<Response>, string]> = [
    [() => new Response("boom", { status: 500 }), "status 500"],
    [() => new Response("not json"), "did not answer with JSON"],
    [() => Response.json({ output: "No ID" }), "needs an `output` string and a `correlationId`"],
    [() => new Response("x".repeat(4_100_000)), "larger than"],
    [
      () =>
        new Promise((resolveAnswer) =>
          setTimeout(() => resolveAnswer(Response.json(ANSWER)), 1_500)
        ),
      "did not answer within 1000 ms",
    ],
  ];
  for (const [answer, expectedReason] of cases) {
    await withTarget(answer, async (port) => {
      const result = await callOnce(port);
      assertEquals(result.status, "error");
      assertStringIncludes((result as { reason: string }).reason, expectedReason);
    });
  }
});

Deno.test("reports a Target that cannot be reached", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const unusedPort = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const result = await callOnce(unusedPort);
  assertStringIncludes((result as { reason: string }).reason, "could not be reached");
});

Deno.test("checks an HTTPS Target's certificate against its host name", async () => {
  const certificateDirectory = await Deno.makeTempDir({ prefix: "extispex-target-tls-" });
  const certificateFile = `${certificateDirectory}/cert.pem`;
  const keyFile = `${certificateDirectory}/key.pem`;
  const openssl = await new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=agent.example.test",
      "-addext",
      "subjectAltName=DNS:agent.example.test",
      "-keyout",
      keyFile,
      "-out",
      certificateFile,
    ],
    stderr: "null",
  }).output();
  assertEquals(openssl.success, true);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    cert: await Deno.readTextFile(certificateFile),
    key: await Deno.readTextFile(keyFile),
    onListen: () => {},
  }, () => Response.json(ANSWER));
  const proxy = startTestProxy();
  const callInProcess = async (
    hostName: string,
    trustedCertificates?: string,
    proxyUrl?: string,
  ) => {
    const { stdout } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        // node:https reads the system's certificate authorities, which takes sys access.
        "--allow-sys",
        new URL("./fixtures/call-https-target.ts", import.meta.url).pathname,
        String(server.addr.port),
        hostName,
        ...(proxyUrl === undefined ? [] : [proxyUrl]),
      ],
      env: trustedCertificates === undefined ? {} : { NODE_EXTRA_CA_CERTS: trustedCertificates },
      stderr: "inherit",
    }).output();
    return JSON.parse(new TextDecoder().decode(stdout)) as TargetCallResult;
  };
  try {
    // The connection goes to the checked address, and the certificate must name the host.
    assertEquals(await callInProcess("agent.example.test", certificateFile), {
      status: "answered",
      ...ANSWER,
    });
    const wrongName = await callInProcess("other.example.test", certificateFile);
    assertStringIncludes((wrongName as { reason: string }).reason, "altnames");
    const untrusted = await callInProcess("agent.example.test");
    assertStringIncludes((untrusted as { reason: string }).reason, "certificate");

    // Through a CONNECT tunnel, the worker still checks the certificate against the host name.
    assertEquals(await callInProcess("agent.example.test", certificateFile, proxy.url), {
      status: "answered",
      ...ANSWER,
    });
    assertEquals(proxy.requests.map((request) => request.requestLine), [
      `CONNECT agent.example.test:${server.addr.port}`,
    ]);
    const wrongNameThroughProxy = await callInProcess(
      "other.example.test",
      certificateFile,
      proxy.url,
    );
    assertStringIncludes((wrongNameThroughProxy as { reason: string }).reason, "altnames");
  } finally {
    await proxy.stop();
    await server.shutdown();
    await Deno.remove(certificateDirectory, { recursive: true });
  }
});

function callThroughProxy(
  targetUrl: string,
  proxyEnvironment: { httpProxy?: string; noProxy?: string },
  allowedDestinations: string,
): Promise<TargetCallResult> {
  const client = createTargetClient({
    allowlist: parseDestinationAllowlist(allowedDestinations),
    timeoutMilliseconds: 2_000,
    // The proxy resolves the name; the worker must not need to.
    resolveHostAddresses: (hostName) =>
      hostName === "127.0.0.1"
        ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
        : Promise.reject(new Error(`resolved ${hostName}`)),
    proxyRouting: parseProxyRouting(proxyEnvironment),
  });
  return client.callTarget(
    {
      url: targetUrl,
      credential: { headerName: "Authorization", headerValue: "Bearer target-secret" },
    },
    { input: { message: "Where is my order?" }, sessionId: null },
  );
}

Deno.test("calls an http Target through HTTP_PROXY, which resolves the name", async () => {
  const proxy = startTestProxy();
  try {
    await withTarget(() => Response.json(ANSWER), async (port, receivedCalls) => {
      const proxyUrl = new URL(proxy.url);
      proxyUrl.username = "worker";
      proxyUrl.password = "proxy secret";
      const result = await callThroughProxy(
        `http://agent.example.test:${port}/evaluate`,
        { httpProxy: proxyUrl.href },
        "agent.example.test",
      );
      assertEquals(result, { status: "answered", ...ANSWER });
      assertEquals(proxy.requests.map((request) => request.requestLine), [
        `POST http://agent.example.test:${port}/evaluate`,
      ]);
      assertEquals(
        proxy.requests[0].headers.get("proxy-authorization"),
        `Basic ${btoa("worker:proxy secret")}`,
      );
      assertEquals(receivedCalls[0].host, `agent.example.test:${port}`);
      assertEquals(receivedCalls[0].authorization, "Bearer target-secret");
    });
  } finally {
    await proxy.stop();
  }
});

Deno.test("calls a Target in NO_PROXY directly", async () => {
  const proxy = startTestProxy();
  try {
    await withTarget(() => Response.json(ANSWER), async (port) => {
      const result = await callThroughProxy(
        `http://127.0.0.1:${port}/evaluate`,
        { httpProxy: proxy.url, noProxy: "localhost,127.0.0.0/8" },
        "127.0.0.1",
      );
      assertEquals(result, { status: "answered", ...ANSWER });
      assertEquals(proxy.requests, []);
    });
  } finally {
    await proxy.stop();
  }
});

Deno.test("through a proxy, a Target's name must be listed, not only a CIDR range", async () => {
  const proxy = startTestProxy();
  try {
    const result = await callThroughProxy(
      "http://agent.example.test:8080/evaluate",
      { httpProxy: proxy.url },
      "127.0.0.0/8",
    );
    assertStringIncludes((result as { reason: string }).reason, "through a proxy");
    assertEquals(proxy.requests, []);
  } finally {
    await proxy.stop();
  }
});
