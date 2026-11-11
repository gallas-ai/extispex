/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import { findExpiredRetentionDays } from "./trace-availability.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");

Deno.test("says a trace is gone once its telemetry is older than the Retention Period", () => {
  assertEquals(findExpiredRetentionDays("2026-10-12T11:59:00Z", 30, NOW), 30);
  assertEquals(findExpiredRetentionDays("2026-10-12T12:01:00Z", 30, NOW), null);
  assertEquals(findExpiredRetentionDays("2026-11-09T12:00:00Z", 1, NOW), 1);
  assertEquals(findExpiredRetentionDays("2026-01-01T00:00:00Z", undefined, NOW), null);
});
