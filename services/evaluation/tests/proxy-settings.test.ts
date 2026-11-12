import { assertEquals, assertThrows } from "@std/assert";
import { InvalidConfigurationError } from "@extispex/service-runtime";
import { parseProxyRouting } from "../src/targets/proxy-settings.ts";

function selectProxy(
  environment: { httpProxy?: string; httpsProxy?: string; noProxy?: string },
  targetUrl: string,
): string | null {
  return parseProxyRouting(environment).selectProxy(new URL(targetUrl))?.href ?? null;
}

Deno.test("chooses the proxy by the Target's scheme", () => {
  const environment = { httpProxy: "http://plain-proxy:3128", httpsProxy: "proxy.internal:8080" };
  assertEquals(
    selectProxy(environment, "http://agent.example/evaluate"),
    "http://plain-proxy:3128/",
  );
  assertEquals(
    selectProxy(environment, "https://agent.example/evaluate"),
    "http://proxy.internal:8080/",
  );
  assertEquals(selectProxy({ httpsProxy: "http://proxy:8080" }, "http://agent.example/"), null);
  assertEquals(selectProxy({}, "https://agent.example/"), null);
});

Deno.test("NO_PROXY matches names, subdomains, ports, addresses, ranges and everything", () => {
  const httpsProxy = "http://proxy:8080";
  const bypasses = (noProxy: string, targetUrl: string) =>
    selectProxy({ httpsProxy, noProxy }, targetUrl) === null;
  assertEquals(bypasses("company.example", "https://company.example/"), true);
  assertEquals(bypasses("company.example", "https://agent.company.example/"), true);
  assertEquals(bypasses(".company.example", "https://agent.company.example/"), true);
  assertEquals(bypasses("*.company.example", "https://agent.company.example/"), true);
  assertEquals(bypasses("company.example", "https://notcompany.example/"), false);
  assertEquals(bypasses("AGENT.example:8443", "https://agent.example:8443/"), true);
  assertEquals(bypasses("agent.example:8443", "https://agent.example/"), false);
  assertEquals(bypasses("10.0.0.0/8, .svc", "https://10.2.3.4/"), true);
  assertEquals(bypasses("10.0.0.0/8, .svc", "https://11.2.3.4/"), false);
  assertEquals(bypasses("10.0.0.0/8, .svc", "https://telemetry.extispex.svc/"), true);
  assertEquals(bypasses("::1", "https://[::1]:8443/"), true);
  assertEquals(bypasses("fd00::/8", "https://[fd12::1]/"), true);
  assertEquals(bypasses("*", "https://anything.example/"), true);
  assertEquals(bypasses("", "https://anything.example/"), false);
});

Deno.test("refuses a proxy that is not plain HTTP and a broken range", () => {
  assertThrows(
    () => parseProxyRouting({ httpsProxy: "https://proxy:8443" }),
    InvalidConfigurationError,
  );
  assertThrows(
    () => parseProxyRouting({ httpsProxy: "http://proxy:8080", noProxy: "10.0.0.0/40" }),
    InvalidConfigurationError,
  );
});
