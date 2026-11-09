import { Migration } from "@mikro-orm/migrations";

/**
 * The search table stores no text of its own and is keyed by `logs.id`, which an explicit integer
 * key keeps stable across VACUUM. Diacritics are kept, like PostgreSQL's `simple` configuration.
 * Only the first 65,536 characters are indexed, as on PostgreSQL.
 */
export class Migration0003CreateLogs extends Migration {
  override up(): void {
    this.addSql(`create table \`logs\` (
      \`id\` integer primary key autoincrement,
      \`project_id\` text not null,
      \`time_unix_nano\` text not null,
      \`log_id\` text not null,
      \`severity_number\` integer not null,
      \`severity_text\` text null,
      \`body_text\` text not null,
      \`structured_body\` json null,
      \`trace_id\` text null,
      \`span_id\` text null,
      \`correlation_id\` text null,
      \`service_name\` text null,
      \`attributes\` json not null,
      \`resource_attributes\` json not null,
      \`received_at\` datetime not null,
      constraint \`logs_identity_unique\` unique (\`project_id\`, \`time_unix_nano\`, \`log_id\`)
    );`);
    this.addSql(
      "create index `logs_project_id_trace_id_index` on `logs` (`project_id`, `trace_id`) where `trace_id` is not null;",
    );
    this.addSql(
      "create index `logs_project_id_correlation_id_index` on `logs` (`project_id`, `correlation_id`) where `correlation_id` is not null;",
    );
    this.addSql(`create virtual table \`logs_search\` using fts5(
      \`body_text\`,
      content = '',
      contentless_delete = 1,
      tokenize = 'unicode61 remove_diacritics 0'
    );`);
    this.addSql(`create trigger \`logs_search_after_insert\` after insert on \`logs\` begin
      insert into \`logs_search\` (rowid, \`body_text\`) values (new.\`id\`, substr(new.\`body_text\`, 1, 65536));
    end;`);
    this.addSql(`create trigger \`logs_search_after_delete\` after delete on \`logs\` begin
      delete from \`logs_search\` where rowid = old.\`id\`;
    end;`);
    this.addSql(`create table \`rejection_counts\` (
      \`project_id\` text not null,
      \`signal\` text not null,
      \`hour_start\` text not null,
      \`rejected_count\` integer not null,
      \`last_reason\` text not null,
      \`last_rejected_at\` text not null,
      primary key (\`project_id\`, \`signal\`, \`hour_start\`)
    );`);
  }
}
