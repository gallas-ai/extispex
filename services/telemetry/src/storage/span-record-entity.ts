import { defineEntity, p } from "@mikro-orm/core";

/**
 * A stored span. Times are kept as zero-padded decimal text: SQLite drivers return 64-bit
 * integers as lossy JavaScript numbers, and padding keeps text order equal to numeric order.
 */
export const SpanRecord = defineEntity({
  name: "SpanRecord",
  tableName: "spans",
  properties: {
    projectId: p.string().primary(),
    traceId: p.string().primary(),
    spanId: p.string().primary(),
    parentSpanId: p.string().nullable(),
    name: p.text(),
    kind: p.string(),
    startTimeUnixNano: p.string(),
    endTimeUnixNano: p.string(),
    durationMilliseconds: p.double(),
    statusCode: p.string(),
    statusMessage: p.text().nullable(),
    serviceName: p.text().nullable(),
    correlationId: p.text(),
    sessionId: p.text().nullable(),
    attributes: p.json<Record<string, unknown>>(),
    resourceAttributes: p.json<Record<string, unknown>>(),
    receivedAt: p.datetime(),
  },
  indexes: [
    { properties: ["projectId", "correlationId"] },
    { properties: ["projectId", "sessionId"] },
    { properties: ["projectId", "startTimeUnixNano"] },
  ],
});

const UNIX_NANOSECONDS_TEXT_LENGTH = 20;

export function formatUnixNanosecondsForStorage(unixNanoseconds: bigint): string {
  return unixNanoseconds.toString().padStart(UNIX_NANOSECONDS_TEXT_LENGTH, "0");
}

export function parseStoredUnixNanoseconds(storedText: string): string {
  return storedText.replace(/^0+(?=\d)/, "");
}
