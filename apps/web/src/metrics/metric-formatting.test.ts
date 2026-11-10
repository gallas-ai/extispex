import { assertEquals } from "@std/assert";
import {
  describeUnit,
  formatMetricValue,
  labelGroupColumn,
  labelSeries,
  summarizeValues,
} from "./metric-formatting.ts";

Deno.test("reads OpenTelemetry's units", () => {
  assertEquals(describeUnit("1", "sum"), "");
  assertEquals(describeUnit("1", "rate"), "/s");
  assertEquals(describeUnit("{request}", "rate"), "request/s");
  assertEquals(describeUnit("ms", "p95"), "ms");
});

Deno.test("formats a value with its unit", () => {
  assertEquals(formatMetricValue(1234.5, "ms"), "1,230 ms");
  assertEquals(formatMetricValue(0.25, "/s"), "0.25/s");
  assertEquals(formatMetricValue(null, "ms"), "–");
});

Deno.test("labels a group by its attribute values and the column by their keys", () => {
  assertEquals(
    labelSeries({ group: { model: "small", region: null }, values: [] }, "tokens"),
    "small · (none)",
  );
  assertEquals(labelSeries({ group: {}, values: [] }, "tokens"), "tokens");
  assertEquals(labelGroupColumn(["model", "region"]), "model · region");
  assertEquals(labelGroupColumn([]), "Series");
});

Deno.test("summarizes the values that exist", () => {
  assertEquals(summarizeValues([null, 2, 6, null]), { latest: 6, average: 4, peak: 6 });
  assertEquals(summarizeValues([null]), { latest: null, average: null, peak: null });
});
