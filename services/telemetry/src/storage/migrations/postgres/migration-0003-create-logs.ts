import { Migration } from "@mikro-orm/migrations";

/**
 * Log records are partitioned by day on their time, so that retention can drop a whole partition.
 * Ingestion creates each day's partition, see `daily-partitions.ts`. The time is the same padded
 * decimal text as on spans; such text sorts like the number, so range partitions work on it.
 * Only the first 65,536 characters are indexed: PostgreSQL refuses a tsvector above 1 MiB, which
 * would fail the record's whole batch on every retry.
 */
export class Migration0003CreateLogs extends Migration {
  override up(): void {
    this.addSql(`create table "logs" (
      "project_id" varchar(255) not null,
      "time_unix_nano" text not null,
      "log_id" varchar(64) not null,
      "severity_number" integer not null,
      "severity_text" text null,
      "body_text" text not null,
      "structured_body" jsonb null,
      "trace_id" varchar(32) null,
      "span_id" varchar(16) null,
      "correlation_id" text null,
      "service_name" text null,
      "attributes" jsonb not null,
      "resource_attributes" jsonb not null,
      "received_at" timestamptz not null,
      "search_vector" tsvector generated always as
        (to_tsvector('simple'::regconfig, left("body_text", 65536))) stored,
      primary key ("project_id", "time_unix_nano", "log_id")
    ) partition by range ("time_unix_nano");`);
    this.addSql(
      `create index "logs_project_id_trace_id_index" on "logs" ("project_id", "trace_id") where "trace_id" is not null;`,
    );
    this.addSql(
      `create index "logs_project_id_correlation_id_index" on "logs" ("project_id", "correlation_id") where "correlation_id" is not null;`,
    );
    this.addSql(`create index "logs_search_vector_index" on "logs" using gin ("search_vector");`);
    this.addSql(`create table "rejection_counts" (
      "project_id" varchar(255) not null,
      "signal" varchar(16) not null,
      "hour_start" varchar(24) not null,
      "rejected_count" bigint not null,
      "last_reason" text not null,
      "last_rejected_at" varchar(24) not null,
      primary key ("project_id", "signal", "hour_start")
    );`);
  }
}
