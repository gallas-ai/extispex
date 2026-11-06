import { z } from "zod";

/** Unix time in nanoseconds, as a decimal string so that no precision is lost in JSON. */
const unixNanosecondsSchema = z.string().regex(/^\d+$/);

export const spanKindSchema = z.enum([
  "unspecified",
  "internal",
  "server",
  "client",
  "producer",
  "consumer",
]);

export const spanStatusCodeSchema = z.enum(["unset", "ok", "error"]);

export const spanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  name: z.string(),
  kind: spanKindSchema,
  startTimeUnixNano: unixNanosecondsSchema,
  endTimeUnixNano: unixNanosecondsSchema,
  durationMilliseconds: z.number(),
  statusCode: spanStatusCodeSchema,
  statusMessage: z.string().nullable(),
  serviceName: z.string().nullable(),
  correlationId: z.string(),
  sessionId: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  resourceAttributes: z.record(z.string(), z.unknown()),
});

export const traceSummarySchema = z.object({
  traceId: z.string(),
  rootSpanName: z.string().nullable(),
  serviceName: z.string().nullable(),
  correlationId: z.string(),
  sessionId: z.string().nullable(),
  startTimeUnixNano: unixNanosecondsSchema,
  durationMilliseconds: z.number(),
  spanCount: z.number().int(),
  hasRootSpan: z.boolean(),
});

export const listTracesQuerySchema = z.object({
  correlationId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const listTracesResponseSchema = z.object({
  traces: z.array(traceSummarySchema),
});

export const traceDetailResponseSchema = z.object({
  traceId: z.string(),
  spans: z.array(spanSchema),
});

export type SpanKind = z.infer<typeof spanKindSchema>;
export type SpanStatusCode = z.infer<typeof spanStatusCodeSchema>;
export type Span = z.infer<typeof spanSchema>;
export type TraceSummary = z.infer<typeof traceSummarySchema>;
export type ListTracesQuery = z.infer<typeof listTracesQuerySchema>;
export type ListTracesResponse = z.infer<typeof listTracesResponseSchema>;
export type TraceDetailResponse = z.infer<typeof traceDetailResponseSchema>;
