import { assertAlmostEquals, assertEquals } from "@std/assert";
import { estimateHistogramQuantile } from "../src/metrics/histogram-quantile.ts";

const P95 = 0.95;

Deno.test("interpolates inside the bucket that holds the quantile", () => {
  const counts = new Map([[10, 50], [100, 40], [1000, 10], [Infinity, 0]]);
  assertAlmostEquals(estimateHistogramQuantile(P95, counts)!, 550);
});

Deno.test("treats the first bucket as starting at zero", () => {
  assertAlmostEquals(estimateHistogramQuantile(0.5, new Map([[10, 100], [Infinity, 0]]))!, 5);
});

Deno.test("reports the first bucket's bound when it is not above zero", () => {
  assertEquals(estimateHistogramQuantile(0.5, new Map([[-5, 10], [Infinity, 0]])), -5);
});

Deno.test("reports the largest finite bound for a quantile in the overflow bucket", () => {
  assertEquals(estimateHistogramQuantile(P95, new Map([[10, 50], [100, 40], [Infinity, 10]])), 100);
});

Deno.test("has no answer without observations or without a finite bound", () => {
  assertEquals(estimateHistogramQuantile(P95, new Map([[10, 0], [Infinity, 0]])), null);
  assertEquals(estimateHistogramQuantile(P95, new Map([[Infinity, 5]])), null);
  assertEquals(estimateHistogramQuantile(P95, new Map()), null);
});

Deno.test("skips empty buckets in the way of the quantile", () => {
  const counts = new Map([[10, 0], [20, 0], [30, 10], [Infinity, 0]]);
  assertAlmostEquals(estimateHistogramQuantile(0.5, counts)!, 25);
});
