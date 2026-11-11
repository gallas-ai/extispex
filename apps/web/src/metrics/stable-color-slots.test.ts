import { assertEquals } from "@std/assert";
import { assignColorSlots } from "./stable-color-slots.ts";

Deno.test("keeps a series' color when others leave the chart", () => {
  const first = assignColorSlots(["a", "b", "c"], new Map(), 8);
  assertEquals([...first], [["a", 0], ["b", 1], ["c", 2]]);
  const second = assignColorSlots(["c", "d"], first, 8);
  assertEquals([...second], [["c", 2], ["d", 0]]);
});
