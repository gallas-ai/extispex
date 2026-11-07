/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import { parseTracesUrlState, serializeTracesUrlState } from "./traces-url-state.ts";

Deno.test("an empty query string means no filters and no open trace", () => {
  assertEquals(parseTracesUrlState(""), {
    correlationId: "",
    sessionId: "",
    traceId: null,
    spanId: null,
  });
});

Deno.test("the URL state survives a round trip and leaves out empty values", () => {
  const urlState = {
    correlationId: "",
    sessionId: "support chat/1",
    traceId: "bcc26b93",
    spanId: null,
  };
  const serialized = serializeTracesUrlState(urlState);
  assertEquals(serialized, "?sessionId=support+chat%2F1&traceId=bcc26b93");
  assertEquals(parseTracesUrlState(serialized), urlState);
});

Deno.test("no state serializes to an empty query string", () => {
  assertEquals(
    serializeTracesUrlState({ correlationId: "", sessionId: "", traceId: null, spanId: null }),
    "",
  );
});
