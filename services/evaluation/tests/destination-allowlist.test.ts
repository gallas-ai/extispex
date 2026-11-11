import { assertEquals, assertThrows } from "@std/assert";
import { InvalidConfigurationError } from "@extispex/service-runtime";
import { parseDestinationAllowlist } from "../src/targets/destination-allowlist.ts";

function decide(configuredList: string, url: string, resolvedAddresses: string[]) {
  const allowlist = parseDestinationAllowlist(configuredList);
  const parsedUrl = new URL(url);
  return allowlist.isUrlAllowed(parsedUrl) &&
    allowlist.areResolvedAddressesAllowed(parsedUrl, resolvedAddresses);
}

Deno.test("allows nothing when the list is empty, and everything with *", () => {
  assertEquals(decide("", "https://agent.company.example/", ["10.0.0.5"]), false);
  assertEquals(decide("*", "http://127.0.0.1:9000/", ["127.0.0.1"]), true);
  assertEquals(decide("*", "http://169.254.169.254/", ["169.254.169.254"]), true);
});

Deno.test("matches listed host names, wildcards and ports", () => {
  const list = "agent.company.example:443, *.internal.company.example";
  assertEquals(decide(list, "https://agent.company.example/chat", ["10.20.0.5"]), true);
  assertEquals(decide(list, "https://AGENT.company.example./chat", ["10.20.0.5"]), true);
  assertEquals(decide(list, "http://agent.company.example/chat", ["10.20.0.5"]), false);
  assertEquals(decide(list, "https://agent.company.example:8443/", ["10.20.0.5"]), false);
  assertEquals(decide(list, "http://bot.internal.company.example:8080/", ["10.1.2.3"]), true);
  assertEquals(decide(list, "http://a.b.internal.company.example/", ["10.1.2.3"]), true);
  assertEquals(decide(list, "http://internal.company.example/", ["10.1.2.3"]), false);
  assertEquals(decide(list, "http://evil-internal.company.example/", ["10.1.2.3"]), false);
  assertEquals(decide(list, "https://other.example/", ["10.20.0.5"]), false);
});

Deno.test("never lets a listed name resolve to the machine or a metadata service", () => {
  const list = "agent.company.example";
  for (
    const protectedAddress of [
      "127.0.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "224.0.0.1",
    ]
  ) {
    assertEquals(
      decide(list, "http://agent.company.example/", [protectedAddress]),
      false,
      protectedAddress,
    );
  }
  // Every address must be allowed, so one bad answer among good ones refuses the call.
  assertEquals(decide(list, "http://agent.company.example/", ["10.0.0.1", "127.0.0.1"]), false);
  assertEquals(decide(list, "http://agent.company.example/", []), false);
});

Deno.test("allows any name or address in a CIDR range, including protected ones", () => {
  const list = "10.20.0.0/16, 127.0.0.0/8, fd00:abcd::/32";
  assertEquals(decide(list, "http://anything.example/", ["10.20.255.1"]), true);
  assertEquals(decide(list, "http://anything.example/", ["10.21.0.1"]), false);
  assertEquals(decide(list, "http://localhost:9000/", ["127.0.0.1"]), true);
  assertEquals(decide(list, "http://[fd00:abcd::5]/", ["fd00:abcd::5"]), true);
  assertEquals(decide(list, "http://[fd00:abce::5]/", ["fd00:abce::5"]), false);
  assertEquals(decide(list, "http://mapped.example/", ["::ffff:10.20.0.9"]), true);
});

Deno.test("treats a listed address as explicit, and judges addresses written in the URL", () => {
  assertEquals(decide("127.0.0.1", "http://127.0.0.1:9000/", ["127.0.0.1"]), true);
  assertEquals(decide("127.0.0.1:9000", "http://127.0.0.1:9001/", ["127.0.0.1"]), false);
  assertEquals(decide("[::1]:8080", "http://[::1]:8080/", ["::1"]), true);
  // The URL parser turns other spellings of an address into the usual one first.
  assertEquals(decide("agent.company.example", "http://2130706433/", ["127.0.0.1"]), false);
  assertEquals(decide("10.0.0.0/8", "http://0x0a.1.2.3/", ["10.1.2.3"]), true);
});

Deno.test("refuses entries it cannot read", () => {
  for (const invalidEntry of ["10.0.0.0/33", "host:99999", "*", "a*.example", "300.1.1.1/8"]) {
    assertThrows(
      () => parseDestinationAllowlist(`agent.example, ${invalidEntry}`),
      InvalidConfigurationError,
      "EVALUATION_TARGET_ALLOWED_DESTINATIONS",
    );
  }
});
