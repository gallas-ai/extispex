import type { LogRecord } from "@extispex/contracts";
import { unixNanosecondsToMilliseconds } from "../traces/trace-formatting.ts";

/** A body as one piece of text: a structure as compact JSON, for the list. */
export function formatLogBody(body: LogRecord["body"]): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

/** A body for reading in full: a structure as indented JSON. */
export function formatLogBodyInFull(body: LogRecord["body"]): string {
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}

/** The date and the time of day separately, because a phone shows only the time. */
export function formatLogTime(timeUnixNano: string): { date: string; time: string } {
  const timestamp = new Date(unixNanosecondsToMilliseconds(timeUnixNano));
  const date = timestamp.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = timestamp.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return { date, time: `${time}.${String(timestamp.getMilliseconds()).padStart(3, "0")}` };
}

/** `2026-11-09T10:30` for a `datetime-local` input, in the browser's time zone. */
export function formatDateTimeLocal(isoTime: string): string {
  if (isoTime === "") return "";
  const timestamp = new Date(isoTime);
  const localTime = new Date(timestamp.getTime() - timestamp.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}
