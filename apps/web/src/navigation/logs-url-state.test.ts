import { assertEquals } from "@std/assert";
import {
  type LogsUrlState,
  parseLogsUrlState,
  resolveLogTimeBounds,
  serializeLogsUrlState,
} from "./logs-url-state.ts";

const EMPTY_STATE: LogsUrlState = {
  search: "",
  minimumSeverity: "",
  serviceName: "",
  correlationId: "",
  traceId: "",
  attribute: "",
  range: "24h",
  from: "",
  to: "",
};

Deno.test("an empty query string is the default view and serializes to nothing", () => {
  assertEquals(parseLogsUrlState(""), EMPTY_STATE);
  assertEquals(serializeLogsUrlState(EMPTY_STATE), "");
});

Deno.test("a view survives the trip through the query string", () => {
  const urlState: LogsUrlState = {
    ...EMPTY_STATE,
    search: "payment failed",
    minimumSeverity: "warn",
    attribute: "gen_ai.request.model=a=b",
    range: "custom",
    from: "2026-11-09T10:00:00.000Z",
    to: "2026-11-09T11:00:00.000Z",
  };
  assertEquals(parseLogsUrlState(serializeLogsUrlState(urlState)), urlState);
});

Deno.test("unknown values in a link fall back to the defaults", () => {
  const urlState = parseLogsUrlState("?minimumSeverity=loud&range=forever");
  assertEquals(urlState.minimumSeverity, "");
  assertEquals(urlState.range, "24h");
});

Deno.test("a preset counts back from now and leaves the end open", () => {
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  assertEquals(resolveLogTimeBounds({ range: "1h", from: "", to: "" }, now), {
    from: "2026-11-09T11:00:00.000Z",
  });
});

Deno.test("a custom range uses the bounds that are set", () => {
  assertEquals(
    resolveLogTimeBounds({ range: "custom", from: "2026-11-09T10:00:00.000Z", to: "" }, 0),
    { from: "2026-11-09T10:00:00.000Z", to: undefined },
  );
});
