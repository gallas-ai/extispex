import { Migration } from "@mikro-orm/migrations";

/** The same two tables as on PostgreSQL, without partitions. */
export class Migration0004CreateMetrics extends Migration {
  override up(): void {
    this.addSql(`create table \`metric_series\` (
      \`project_id\` text not null,
      \`series_id\` text not null,
      \`metric_name\` text not null,
      \`metric_type\` text not null,
      \`unit\` text not null,
      \`temporality\` text null,
      \`is_monotonic\` integer null,
      \`explicit_bounds\` text null,
      \`service_name\` text null,
      \`attributes\` json not null,
      \`resource_attributes\` json not null,
      \`last_seen_unix_nano\` text not null,
      primary key (\`project_id\`, \`series_id\`)
    );`);
    this.addSql(
      "create index `metric_series_project_id_metric_name_index` on `metric_series` (`project_id`, `metric_name`);",
    );
    this.addSql(`create table \`metric_points\` (
      \`project_id\` text not null,
      \`series_id\` text not null,
      \`time_unix_nano\` text not null,
      \`start_time_unix_nano\` text null,
      \`value\` real null,
      \`histogram_count\` real null,
      \`histogram_sum\` real null,
      \`bucket_counts\` text null,
      \`received_at\` datetime not null,
      primary key (\`project_id\`, \`series_id\`, \`time_unix_nano\`)
    );`);
  }
}
