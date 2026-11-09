import { z } from "zod";

export const logSeveritySchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

/** The lowest OTLP severity number of each severity, so that `error` covers ERROR to ERROR4. */
export const MINIMUM_SEVERITY_NUMBERS = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const;

export const logRecordSchema = z.object({
  /** Identifies the record's content within the Project. */
  logId: z.string(),
  /** Unix time in nanoseconds, as a decimal string so that no precision is lost in JSON. */
  timeUnixNano: z.string().regex(/^\d+$/),
  severity: logSeveritySchema.nullable(),
  severityNumber: z.number().int(),
  severityText: z.string().nullable(),
  /** A string, or the original structure when the application logged a map or a list. */
  body: z.unknown(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  correlationId: z.string().nullable(),
  serviceName: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  resourceAttributes: z.record(z.string(), z.unknown()),
});

const isoTimeSchema = z.iso.datetime({ offset: true });
const attributeFilterSchema = z.string().regex(/^[^=]+=/);

export const MAXIMUM_LOG_ATTRIBUTE_FILTERS = 10;

export const listLogsQuerySchema = z.object({
  /** Records at or after this time. */
  from: isoTimeSchema.optional(),
  /** Records before this time. */
  to: isoTimeSchema.optional(),
  /** Words that must all appear in the body; case does not matter. */
  search: z.string().regex(/\S/).max(500).optional(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  correlationId: z.string().min(1).optional(),
  serviceName: z.string().min(1).optional(),
  /** This severity or a higher one. */
  minimumSeverity: logSeveritySchema.optional(),
  /** `key=value`, which may be repeated. Every filter must match. */
  attribute: z.union([
    attributeFilterSchema,
    z.array(attributeFilterSchema).max(MAXIMUM_LOG_ATTRIBUTE_FILTERS),
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().regex(/^\d{1,20}\.[0-9a-f]{64}$/).optional(),
});

export const listLogsResponseSchema = z.object({
  logs: z.array(logRecordSchema),
  nextCursor: z.string().nullable(),
});

export type LogSeverity = z.infer<typeof logSeveritySchema>;
export type LogRecord = z.infer<typeof logRecordSchema>;
export type ListLogsQuery = z.infer<typeof listLogsQuerySchema>;
export type ListLogsResponse = z.infer<typeof listLogsResponseSchema>;

/** The severity of an OTLP severity number, or null for an unspecified one. */
export function logSeverityFromNumber(severityNumber: number): LogSeverity | null {
  const severities = logSeveritySchema.options;
  for (let severityIndex = severities.length - 1; severityIndex >= 0; severityIndex--) {
    const severity = severities[severityIndex];
    if (severityNumber >= MINIMUM_SEVERITY_NUMBERS[severity]) return severity;
  }
  return null;
}
