import { z } from "zod";

export const rejectedTelemetrySummarySchema = z.object({
  rejectedCount: z.number().int(),
  lastReason: z.string().nullable(),
  lastRejectedAt: z.string().nullable(),
});

export const rejectedTelemetrySchema = z.object({
  /** The counts cover about this many hours before now. */
  windowHours: z.number().int(),
  spans: rejectedTelemetrySummarySchema,
  logs: rejectedTelemetrySummarySchema,
});

export type RejectedTelemetrySummary = z.infer<typeof rejectedTelemetrySummarySchema>;
export type RejectedTelemetry = z.infer<typeof rejectedTelemetrySchema>;
