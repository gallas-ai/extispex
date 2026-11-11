import { Migration } from "@mikro-orm/migrations";

/**
 * A Time Series is stored once, and its points only refer to it, because a metric repeats the same
 * attributes on every export. Points are partitioned by day like log records, see
 * `daily-partitions.ts`. Bucket counts are text: only the application reads them.
 */
export class Migration0004CreateMetrics extends Migration {
  override up(): void {
    this.addSql(`create table "metric_series" (
      "project_id" varchar(255) not null,
      "series_id" varchar(64) not null,
      "metric_name" varchar(255) not null,
      "metric_type" varchar(16) not null,
      "unit" text not null,
      "temporality" varchar(16) null,
      "is_monotonic" boolean null,
      "explicit_bounds" text null,
      "service_name" text null,
      "attributes" jsonb not null,
      "resource_attributes" jsonb not null,
      "last_seen_unix_nano" text not null,
      primary key ("project_id", "series_id")
    );`);
    this.addSql(
      `create index "metric_series_project_id_metric_name_index" on "metric_series" ("project_id", "metric_name");`,
    );
    this.addSql(`create table "metric_points" (
      "project_id" varchar(255) not null,
      "series_id" varchar(64) not null,
      "time_unix_nano" text not null,
      "start_time_unix_nano" text null,
      "value" double precision null,
      "histogram_count" double precision null,
      "histogram_sum" double precision null,
      "bucket_counts" text null,
      "received_at" timestamptz not null,
      primary key ("project_id", "series_id", "time_unix_nano")
    ) partition by range ("time_unix_nano");`);
  }
}
