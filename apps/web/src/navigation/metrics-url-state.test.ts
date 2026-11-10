import { assertEquals } from "@std/assert";
import {
  chooseAggregation,
  type MetricsUrlState,
  parseMetricsUrlState,
  resolveMetricTimeBounds,
  serializeMetricsUrlState,
} from "./metrics-url-state.ts";

const EMPTY_STATE: MetricsUrlState = {
  metric: "",
  aggregation: "",
  groupBy: "",
  attribute: "",
  range: "1h",
};

Deno.test("an empty query string is the default view and serializes to nothing", () => {
  assertEquals(parseMetricsUrlState(""), EMPTY_STATE);
  assertEquals(serializeMetricsUrlState(EMPTY_STATE), "");
});

Deno.test("a chart survives the trip through the query string", () => {
  const urlState: MetricsUrlState = {
    metric: "gen_ai.client.token.usage",
    aggregation: "p95",
    groupBy: "gen_ai.request.model",
    attribute: "region=eu=west",
    range: "24h",
  };
  assertEquals(parseMetricsUrlState(serializeMetricsUrlState(urlState)), urlState);
});

Deno.test("an unknown aggregation or range falls back to the defaults", () => {
  assertEquals(parseMetricsUrlState("?aggregation=median&range=3w"), EMPTY_STATE);
});

Deno.test("opens a metric with the aggregation that suits it", () => {
  assertEquals(chooseAggregation("", ["sum", "avg", "rate", "p95"]), "p95");
  assertEquals(chooseAggregation("", ["sum", "avg", "rate"]), "rate");
  assertEquals(chooseAggregation("", ["sum", "avg"]), "avg");
  assertEquals(chooseAggregation("sum", ["sum", "avg", "rate"]), "sum");
  assertEquals(chooseAggregation("p95", ["sum", "avg"]), "avg");
});

Deno.test("counts a preset back from now", () => {
  assertEquals(resolveMetricTimeBounds("15m", Date.parse("2026-11-09T12:00:00Z")), {
    from: "2026-11-09T11:45:00.000Z",
    to: "2026-11-09T12:00:00.000Z",
  });
});
