import { Migration } from "@mikro-orm/migrations";

export class Migration0001CreateSpans extends Migration {
  override up(): void {
    this.addSql(`create table \`spans\` (
      \`project_id\` text not null,
      \`trace_id\` text not null,
      \`span_id\` text not null,
      \`parent_span_id\` text null,
      \`name\` text not null,
      \`kind\` text not null,
      \`start_time_unix_nano\` text not null,
      \`end_time_unix_nano\` text not null,
      \`duration_milliseconds\` double not null,
      \`status_code\` text not null,
      \`status_message\` text null,
      \`service_name\` text null,
      \`correlation_id\` text not null,
      \`session_id\` text null,
      \`attributes\` json not null,
      \`resource_attributes\` json not null,
      \`received_at\` datetime not null,
      primary key (\`project_id\`, \`trace_id\`, \`span_id\`)
    );`);
    this.addSql(
      "create index `spans_project_id_correlation_id_index` on `spans` (`project_id`, `correlation_id`);",
    );
    this.addSql(
      "create index `spans_project_id_session_id_index` on `spans` (`project_id`, `session_id`);",
    );
    this.addSql(
      "create index `spans_project_id_start_time_unix_nano_index` on `spans` (`project_id`, `start_time_unix_nano`);",
    );
  }
}
