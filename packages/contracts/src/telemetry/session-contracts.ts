import { z } from "zod";

/** Unix time in nanoseconds, as a decimal string so that no precision is lost in JSON. */
const unixNanosecondsSchema = z.string().regex(/^\d+$/);

/** The most traces one Session's conversation holds; a longer Session is `truncated`. */
export const SESSION_CONVERSATION_TRACE_LIMIT = 500;

export const sessionConversationTraceSchema = z.object({
  traceId: z.string(),
  rootSpanName: z.string().nullable(),
  serviceName: z.string().nullable(),
  correlationId: z.string(),
  startTimeUnixNano: unixNanosecondsSchema,
  durationMilliseconds: z.number(),
  spanCount: z.number().int(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  errorSpanCount: z.number().int(),
  /** The status message of the earliest span with status `error`. */
  firstErrorMessage: z.string().nullable(),
  /** The text of the user's message, or null if the trace carries none. */
  userMessage: z.string().nullable(),
  /** The text of the assistant's reply, or null if the trace carries none. */
  assistantMessage: z.string().nullable(),
  /** Names of the tools the trace called, in the order they were called. */
  toolNames: z.array(z.string()),
});

export const sessionConversationSummarySchema = z.object({
  traceCount: z.number().int(),
  firstStartTimeUnixNano: unixNanosecondsSchema,
  lastEndTimeUnixNano: unixNanosecondsSchema,
  /** From the start of the first trace to the end of the last one. */
  durationMilliseconds: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  tracesWithErrors: z.number().int(),
});

export const sessionConversationResponseSchema = z.object({
  sessionId: z.string(),
  summary: sessionConversationSummarySchema,
  /** Oldest first. */
  traces: z.array(sessionConversationTraceSchema),
  /** Whether the Session has more traces than the conversation holds. */
  truncated: z.boolean(),
});

export type SessionConversationTrace = z.infer<typeof sessionConversationTraceSchema>;
export type SessionConversationSummary = z.infer<typeof sessionConversationSummarySchema>;
export type SessionConversationResponse = z.infer<typeof sessionConversationResponseSchema>;
