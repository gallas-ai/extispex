import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { describeErrorResponse } from "../openapi-route-parts.ts";
import { spanSchema } from "./trace-contracts.ts";

/** The most spans the worker reads for one Iteration; more makes the Iteration an Error. */
export const MAXIMUM_EVALUATED_SPANS = 10_000;

const correlationIdPathSchema = z.object({ correlationId: z.string().min(1) });
const sessionIdPathSchema = z.object({ sessionId: z.string().min(1) });

/**
 * `readAt` is Telemetry's own clock at the moment of the answer, so that the worker measures how
 * long a span has been stored without comparing the clocks of two services.
 */
export const correlationTelemetrySchema = z.object({
  readAt: z.string(),
  firstReceivedAt: z.string().nullable(),
  traces: z.array(z.object({
    traceId: z.string(),
    /** When the trace's root span was stored; null while no root span has arrived. */
    rootSpanStoredAt: z.string().nullable(),
  })),
});

export const sessionTelemetrySchema = z.object({
  readAt: z.string(),
  firstReceivedAt: z.string().nullable(),
});

export const correlationSpansSchema = z.object({
  readAt: z.string(),
  spans: z.array(spanSchema),
  /** True when the Correlation ID has more spans than {@link MAXIMUM_EVALUATED_SPANS}. */
  isTruncated: z.boolean(),
});

export const markCorrelationEvaluatedRequestSchema = z.strictObject({
  /** The `readAt` of the spans the Evaluators saw. */
  evaluatedAt: z.iso.datetime(),
});

const internalResponses = {
  400: describeErrorResponse("The request is invalid."),
  401: describeErrorResponse("The caller is not a service with a service token for a Project."),
};

/**
 * The Telemetry endpoints for the Evaluation worker. They are internal: the Gateway does not
 * forward them, because they are not in `publicApiRoutesByService`. Telemetry's port is reachable
 * by OTLP exporters, so each one takes a service token for the Project and nothing else.
 */
export const readCorrelationTelemetryRoute = createRoute({
  method: "get",
  path: "/internal/v1/correlations/{correlationId}",
  summary: "Read when a Correlation ID's telemetry and root spans were stored.",
  tags: ["Internal"],
  security: [{ accessToken: [] }],
  request: { params: correlationIdPathSchema },
  responses: {
    200: {
      description: "The Correlation ID's state, with no traces if it has no telemetry.",
      content: { "application/json": { schema: correlationTelemetrySchema } },
    },
    ...internalResponses,
  },
});

export const readSessionTelemetryRoute = createRoute({
  method: "get",
  path: "/internal/v1/sessions/{sessionId}",
  summary: "Read when a Session's telemetry was first stored.",
  tags: ["Internal"],
  security: [{ accessToken: [] }],
  request: { params: sessionIdPathSchema },
  responses: {
    200: {
      description: "The Session's state.",
      content: { "application/json": { schema: sessionTelemetrySchema } },
    },
    ...internalResponses,
  },
});

export const listCorrelationSpansRoute = createRoute({
  method: "get",
  path: "/internal/v1/correlations/{correlationId}/spans",
  summary: "Read the spans of a Correlation ID's traces, for judging them.",
  tags: ["Internal"],
  security: [{ accessToken: [] }],
  request: { params: correlationIdPathSchema },
  responses: {
    200: {
      description: "The spans, ordered by start time.",
      content: { "application/json": { schema: correlationSpansSchema } },
    },
    ...internalResponses,
  },
});

export const markCorrelationEvaluatedRoute = createRoute({
  method: "post",
  path: "/internal/v1/correlations/{correlationId}/evaluated",
  summary: "Record that a Correlation ID's spans were judged.",
  tags: ["Internal"],
  security: [{ accessToken: [] }],
  request: {
    params: correlationIdPathSchema,
    body: { content: { "application/json": { schema: markCorrelationEvaluatedRequestSchema } } },
  },
  responses: {
    204: { description: "Recorded. Spans received after this time are flagged." },
    ...internalResponses,
  },
});

export type CorrelationTelemetryResponse = z.infer<typeof correlationTelemetrySchema>;
export type SessionTelemetryResponse = z.infer<typeof sessionTelemetrySchema>;
export type CorrelationSpansResponse = z.infer<typeof correlationSpansSchema>;
export type MarkCorrelationEvaluatedRequest = z.infer<typeof markCorrelationEvaluatedRequestSchema>;
