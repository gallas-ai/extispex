import type { ListLogsQuery, LogRecord } from "@extispex/contracts";
import {
  logSeverityFromNumber,
  MINIMUM_SEVERITY_NUMBERS,
  parseAttributeFilters,
} from "@extispex/contracts";
import type { EntityManager } from "@mikro-orm/sql";
import type { IncomingLogRecord } from "../ingestion/mod.ts";
import { createDailyPartitions } from "./daily-partitions.ts";
import {
  formatUnixNanosecondsForStorage,
  parseStoredUnixNanoseconds,
} from "./span-record-entity.ts";
import type { TelemetryDatabase } from "./telemetry-database.ts";

export interface LogPage {
  logs: LogRecord[];
  nextCursor: string | null;
}

export interface LogRepository {
  /** Stores log records, ignoring any already stored, because exporters retry whole batches. */
  insertLogRecords(
    projectId: string,
    logRecords: IncomingLogRecord[],
    receivedAt: Date,
  ): Promise<void>;
  /** Returns one page of matching records, newest first. */
  listLogs(projectId: string, query: ListLogsQuery): Promise<LogPage>;
}

/** Keeps one statement well below PostgreSQL's limit of 65,535 parameters and SQLite's 32,766. */
const INSERT_BATCH_ROW_COUNT = 500;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

const SELECTED_COLUMNS = `time_unix_nano, log_id, severity_number, severity_text, body_text,
  structured_body, trace_id, span_id, correlation_id, service_name, attributes,
  resource_attributes`;

interface LogRow {
  time_unix_nano: string;
  log_id: string;
  severity_number: number | string;
  severity_text: string | null;
  body_text: string;
  structured_body: unknown;
  trace_id: string | null;
  span_id: string | null;
  correlation_id: string | null;
  service_name: string | null;
  attributes: unknown;
  resource_attributes: unknown;
}

interface LogFilter {
  conditions: string[];
  parameters: unknown[];
}

export function createLogRepository(database: TelemetryDatabase): LogRepository {
  const logPartitions = createDailyPartitions(database, "logs");
  const isPostgres = database.dialect === "postgresql";

  return {
    async insertLogRecords(projectId, logRecords, receivedAt) {
      await logPartitions.ensurePartitionsFor(logRecords.map((record) => record.timeUnixNano));
      await database.orm.em.fork().transactional(async (entityManager) => {
        for (let rowIndex = 0; rowIndex < logRecords.length; rowIndex += INSERT_BATCH_ROW_COUNT) {
          await insertRows(
            entityManager,
            isPostgres,
            projectId,
            logRecords.slice(rowIndex, rowIndex + INSERT_BATCH_ROW_COUNT),
            receivedAt,
          );
        }
      });
    },

    async listLogs(projectId, query) {
      const filter = buildLogFilter(projectId, query, isPostgres);
      const rows = await database.orm.em.fork().execute<LogRow[]>(
        `select ${SELECTED_COLUMNS}
          from logs
          where ${filter.conditions.join(" and ")}
          order by time_unix_nano desc, log_id desc
          limit ?`,
        [...filter.parameters, query.limit + 1],
      );
      const pageRows = rows.slice(0, query.limit);
      const lastRow = pageRows.at(-1);
      return {
        logs: pageRows.map(convertRowToLogRecord),
        nextCursor: rows.length > query.limit && lastRow !== undefined
          ? `${parseStoredUnixNanoseconds(lastRow.time_unix_nano)}.${lastRow.log_id}`
          : null,
      };
    },
  };
}

async function insertRows(
  entityManager: EntityManager,
  isPostgres: boolean,
  projectId: string,
  logRecords: IncomingLogRecord[],
  receivedAt: Date,
): Promise<void> {
  const jsonPlaceholder = isPostgres ? "?::jsonb" : "?";
  const rowPlaceholder =
    `(?, ?, ?, ?, ?, ?, ${jsonPlaceholder}, ?, ?, ?, ?, ${jsonPlaceholder}, ${jsonPlaceholder}, ?)`;
  await entityManager.execute(
    `insert into logs (project_id, time_unix_nano, log_id, severity_number, severity_text,
        body_text, structured_body, trace_id, span_id, correlation_id, service_name, attributes,
        resource_attributes, received_at)
      values ${logRecords.map(() => rowPlaceholder).join(", ")}
      on conflict (project_id, time_unix_nano, log_id) do nothing`,
    logRecords.flatMap((logRecord) => [
      projectId,
      formatUnixNanosecondsForStorage(logRecord.timeUnixNano),
      logRecord.logId,
      logRecord.severityNumber,
      logRecord.severityText,
      logRecord.bodyText,
      logRecord.structuredBody === null ? null : JSON.stringify(logRecord.structuredBody),
      logRecord.traceId,
      logRecord.spanId,
      logRecord.correlationId,
      logRecord.serviceName,
      JSON.stringify(logRecord.attributes),
      JSON.stringify(logRecord.resourceAttributes),
      receivedAt.toISOString(),
    ]),
  );
}

function buildLogFilter(
  projectId: string,
  query: ListLogsQuery,
  isPostgres: boolean,
): LogFilter {
  const filter: LogFilter = { conditions: ["project_id = ?"], parameters: [projectId] };
  const addCondition = (condition: string, ...parameters: unknown[]) => {
    filter.conditions.push(condition);
    filter.parameters.push(...parameters);
  };
  if (query.from !== undefined) addCondition("time_unix_nano >= ?", formatIsoTime(query.from));
  if (query.to !== undefined) addCondition("time_unix_nano < ?", formatIsoTime(query.to));
  if (query.traceId !== undefined) addCondition("trace_id = ?", query.traceId);
  if (query.correlationId !== undefined) addCondition("correlation_id = ?", query.correlationId);
  if (query.serviceName !== undefined) addCondition("service_name = ?", query.serviceName);
  if (query.minimumSeverity !== undefined) {
    addCondition("severity_number >= ?", MINIMUM_SEVERITY_NUMBERS[query.minimumSeverity]);
  }
  for (const attributeFilter of parseAttributeFilters(query.attribute)) {
    if (isPostgres) {
      addCondition("attributes ->> ?::text = ?", attributeFilter.key, attributeFilter.value);
    } else {
      // json_each, because a key such as gen_ai.request.model cannot be written safely as a path.
      addCondition(
        `exists (select 1 from json_each(logs.attributes)
          where json_each.key = ?
            and case json_each.type
              when 'true' then 'true'
              when 'false' then 'false'
              else cast(json_each.value as text)
            end = ?)`,
        attributeFilter.key,
        attributeFilter.value,
      );
    }
  }
  if (query.search !== undefined) {
    if (isPostgres) {
      addCondition("search_vector @@ plainto_tsquery('simple', ?)", query.search);
    } else {
      addCondition(
        "id in (select rowid from logs_search where logs_search match ?)",
        convertToFts5Query(query.search),
      );
    }
  }
  if (query.cursor !== undefined) {
    const [cursorTime, cursorLogId] = query.cursor.split(".");
    const storedCursorTime = formatUnixNanosecondsForStorage(BigInt(cursorTime));
    // The plain bound lets PostgreSQL skip partitions, which the row comparison alone would not.
    addCondition("time_unix_nano <= ?", storedCursorTime);
    addCondition("(time_unix_nano, log_id) < (?, ?)", storedCursorTime, cursorLogId);
  }
  return filter;
}

/** Every word as a quoted FTS5 string, so that user input cannot be read as query syntax. */
function convertToFts5Query(searchText: string): string {
  return searchText.trim().split(/\s+/).map((word) => `"${word.replaceAll('"', '""')}"`).join(" ");
}

function formatIsoTime(isoTime: string): string {
  return formatUnixNanosecondsForStorage(BigInt(Date.parse(isoTime)) * NANOSECONDS_PER_MILLISECOND);
}

function parseJsonColumn(columnValue: unknown): unknown {
  return typeof columnValue === "string" ? JSON.parse(columnValue) : columnValue;
}

function convertRowToLogRecord(row: LogRow): LogRecord {
  const severityNumber = Number(row.severity_number);
  const structuredBody = row.structured_body === null ? null : parseJsonColumn(row.structured_body);
  return {
    logId: row.log_id,
    timeUnixNano: parseStoredUnixNanoseconds(row.time_unix_nano),
    severity: logSeverityFromNumber(severityNumber),
    severityNumber,
    severityText: row.severity_text,
    body: structuredBody ?? row.body_text,
    traceId: row.trace_id,
    spanId: row.span_id,
    correlationId: row.correlation_id,
    serviceName: row.service_name,
    attributes: parseJsonColumn(row.attributes) as Record<string, unknown>,
    resourceAttributes: parseJsonColumn(row.resource_attributes) as Record<string, unknown>,
  };
}
