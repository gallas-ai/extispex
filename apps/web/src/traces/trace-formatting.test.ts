/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import {
  buildTimeAxisTicks,
  formatDuration,
  formatRelativeTime,
  formatStructuredAttributeValue,
  shortenIdentifier,
} from "./trace-formatting.ts";

Deno.test("durations use the unit that keeps them readable", () => {
  assertEquals(formatDuration(0.034), "34 µs");
  assertEquals(formatDuration(4.2), "4.20 ms");
  assertEquals(formatDuration(160), "160 ms");
  assertEquals(formatDuration(2_500), "2.50 s");
  assertEquals(formatDuration(125_000), "2 min 5 s");
});

Deno.test("relative times count up in the largest whole unit", () => {
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  assertEquals(formatRelativeTime(now - 2_000, now), "just now");
  assertEquals(formatRelativeTime(now - 42_000, now), "42 s ago");
  assertEquals(formatRelativeTime(now - 5 * 60_000, now), "5 min ago");
  assertEquals(formatRelativeTime(now - 3 * 3_600_000, now), "3 h ago");
  assertEquals(formatRelativeTime(now - 2 * 86_400_000, now), "2 d ago");
});

Deno.test("a timestamp slightly in the future reads as just now", () => {
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  assertEquals(formatRelativeTime(now + 1_500, now), "just now");
});

Deno.test("time axis ticks span the whole trace", () => {
  assertEquals(buildTimeAxisTicks(200, 4), [
    { offsetPercent: 0, label: "0" },
    { offsetPercent: 25, label: "50 ms" },
    { offsetPercent: 50, label: "100 ms" },
    { offsetPercent: 75, label: "150 ms" },
    { offsetPercent: 100, label: "200 ms" },
  ]);
});

Deno.test("long identifiers are shortened, short ones are kept", () => {
  assertEquals(shortenIdentifier("bcc26b9321692a300dcebb2313c6b41c"), "bcc26b93…");
  assertEquals(shortenIdentifier("abc123456"), "abc123456");
});

Deno.test("objects and JSON strings are indented, plain values are not", () => {
  assertEquals(formatStructuredAttributeValue({ role: "user" }), '{\n  "role": "user"\n}');
  assertEquals(
    formatStructuredAttributeValue('[{"role":"user"}]'),
    '[\n  {\n    "role": "user"\n  }\n]',
  );
  assertEquals(formatStructuredAttributeValue("{not json"), null);
  assertEquals(formatStructuredAttributeValue("example-model"), null);
  assertEquals(formatStructuredAttributeValue(42), null);
});
