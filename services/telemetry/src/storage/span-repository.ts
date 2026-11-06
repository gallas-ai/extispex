import type { ListTracesQuery, Span, TraceSummary } from "@evaluation-telemetry/contracts";
import type { EntityManager } from "@mikro-orm/sql";
import type { CorrelatedSpan } from "../ingestion/correlation-policy.ts";
import {
  formatUnixNanosecondsForStorage,
  parseStoredUnixNanoseconds,
  SpanRecord,
} from "./span-record-entity.ts";
import type { TelemetryDatabase } from "./telemetry-database.ts";

export interface SpanRepository {
  /** Stores spans, ignoring any span already stored, because exporters retry whole batches. */
  insertSpans(projectId: string, spans: CorrelatedSpan[], receivedAt: Date): Promise<void>;
  listTraces(projectId: string, query: ListTracesQuery): Promise<TraceSummary[]>;
  /** Returns the trace's spans ordered by start time, or an empty list for an unknown trace. */
  findTraceSpans(projectId: string, traceId: string): Promise<Span[]>;
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

interface TraceAggregateRow {
  trace_id: string;
  trace_start_time_unix_nano: string;
  trace_end_time_unix_nano: string;
  span_count: number | string;
}

interface RepresentativeSpanRow {
  trace_id: string;
  name: string;
  parent_span_id: string | null;
  service_name: string | null;
  correlation_id: string;
  session_id: string | null;
}

export function createSpanRepository(database: TelemetryDatabase): SpanRepository {
  return {
    async insertSpans(projectId, spans, receivedAt) {
      const entityManager = database.orm.em.fork();
      const spanRows = spans.map((span) => ({
        projectId,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        kind: span.kind,
        startTimeUnixNano: formatUnixNanosecondsForStorage(span.startTimeUnixNano),
        endTimeUnixNano: formatUnixNanosecondsForStorage(span.endTimeUnixNano),
        durationMilliseconds: calculateDurationMilliseconds(
          span.startTimeUnixNano,
          span.endTimeUnixNano,
        ),
        statusCode: span.statusCode,
        statusMessage: span.statusMessage,
        serviceName: span.serviceName,
        correlationId: span.correlationId,
        sessionId: span.sessionId,
        attributes: span.attributes,
        resourceAttributes: span.resourceAttributes,
        receivedAt,
      }));
      await entityManager.createQueryBuilder(SpanRecord)
        .insert(spanRows)
        .onConflict(["projectId", "traceId", "spanId"])
        .ignore()
        .execute();
    },

    async listTraces(projectId, query) {
      const entityManager = database.orm.em.fork();
      const traceFilter = buildTraceFilter(query);
      const traceAggregates = await entityManager.execute<TraceAggregateRow[]>(
        `select trace_id,
            min(start_time_unix_nano) as trace_start_time_unix_nano,
            max(end_time_unix_nano) as trace_end_time_unix_nano,
            count(*) as span_count
          from spans
          where project_id = ?
            and trace_id in (select trace_id from spans where project_id = ? ${traceFilter.condition})
          group by trace_id
          order by trace_start_time_unix_nano desc
          limit ?`,
        [projectId, projectId, ...traceFilter.parameters, query.limit],
      );
      if (traceAggregates.length === 0) {
        return [];
      }
      const traceIds = traceAggregates.map((traceAggregate) => traceAggregate.trace_id);
      const representativeSpans = await findRepresentativeSpans(entityManager, projectId, traceIds);
      return traceAggregates.map((traceAggregate) => {
        const representativeSpan = representativeSpans.get(traceAggregate.trace_id);
        const traceStart = BigInt(traceAggregate.trace_start_time_unix_nano);
        const traceEnd = BigInt(traceAggregate.trace_end_time_unix_nano);
        const hasRootSpan = representativeSpan?.parent_span_id === null;
        return {
          traceId: traceAggregate.trace_id,
          rootSpanName: hasRootSpan ? representativeSpan.name : null,
          serviceName: representativeSpan?.service_name ?? null,
          correlationId: representativeSpan?.correlation_id ?? "",
          sessionId: representativeSpan?.session_id ?? null,
          startTimeUnixNano: parseStoredUnixNanoseconds(traceAggregate.trace_start_time_unix_nano),
          durationMilliseconds: calculateDurationMilliseconds(traceStart, traceEnd),
          spanCount: Number(traceAggregate.span_count),
          hasRootSpan,
        };
      });
    },

    async findTraceSpans(projectId, traceId) {
      const entityManager = database.orm.em.fork();
      const spanRecords = await entityManager.find(
        SpanRecord,
        { projectId, traceId },
        { orderBy: { startTimeUnixNano: "asc" } },
      );
      return spanRecords.map((spanRecord) => ({
        traceId: spanRecord.traceId,
        spanId: spanRecord.spanId,
        parentSpanId: spanRecord.parentSpanId ?? null,
        name: spanRecord.name,
        kind: spanRecord.kind as Span["kind"],
        startTimeUnixNano: parseStoredUnixNanoseconds(spanRecord.startTimeUnixNano),
        endTimeUnixNano: parseStoredUnixNanoseconds(spanRecord.endTimeUnixNano),
        durationMilliseconds: Number(spanRecord.durationMilliseconds),
        statusCode: spanRecord.statusCode as Span["statusCode"],
        statusMessage: spanRecord.statusMessage ?? null,
        serviceName: spanRecord.serviceName ?? null,
        correlationId: spanRecord.correlationId,
        sessionId: spanRecord.sessionId ?? null,
        attributes: spanRecord.attributes,
        resourceAttributes: spanRecord.resourceAttributes,
      }));
    },
  };
}

function buildTraceFilter(query: ListTracesQuery): { condition: string; parameters: string[] } {
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (query.correlationId) {
    conditions.push("and correlation_id = ?");
    parameters.push(query.correlationId);
  }
  if (query.sessionId) {
    conditions.push("and session_id = ?");
    parameters.push(query.sessionId);
  }
  return { condition: conditions.join(" "), parameters };
}

/** Picks one span per trace to describe it: the root span if stored, otherwise the earliest span. */
async function findRepresentativeSpans(
  entityManager: EntityManager,
  projectId: string,
  traceIds: string[],
): Promise<Map<string, RepresentativeSpanRow>> {
  const traceIdPlaceholders = traceIds.map(() => "?").join(", ");
  const representativeRows = await entityManager.execute<RepresentativeSpanRow[]>(
    `select trace_id, name, parent_span_id, service_name, correlation_id, session_id
      from (
        select trace_id, name, parent_span_id, service_name, correlation_id, session_id,
          row_number() over (
            partition by trace_id
            order by case when parent_span_id is null then 0 else 1 end, start_time_unix_nano
          ) as span_rank
        from spans
        where project_id = ? and trace_id in (${traceIdPlaceholders})
      ) ranked_spans
      where span_rank = 1`,
    [projectId, ...traceIds],
  );
  return new Map(
    representativeRows.map((representativeRow) => [representativeRow.trace_id, representativeRow]),
  );
}

function calculateDurationMilliseconds(
  startUnixNanoseconds: bigint,
  endUnixNanoseconds: bigint,
): number {
  const durationNanoseconds = endUnixNanoseconds > startUnixNanoseconds
    ? endUnixNanoseconds - startUnixNanoseconds
    : 0n;
  const wholeMilliseconds = durationNanoseconds / NANOSECONDS_PER_MILLISECOND;
  const remainingNanoseconds = durationNanoseconds % NANOSECONDS_PER_MILLISECOND;
  return Number(wholeMilliseconds) +
    Number(remainingNanoseconds) / Number(NANOSECONDS_PER_MILLISECOND);
}
