import { Migration } from "@mikro-orm/migrations";

const SUMMARY_COLUMNS = [
  "`summary_status` text null",
  "`summary_provider_id` text null",
  "`summary_provider_name` text null",
  "`summary_prompt_name` text null",
  "`summary_prompt_version` integer null",
  "`summary_text` text null",
  "`summary_error` text null",
  "`summary_model` text null",
  "`summary_attempts` integer not null default 0",
  "`summary_requested_at` datetime null",
  "`summary_generated_at` datetime null",
];

export class Migration0004AddLlmProviders extends Migration {
  override up(): void {
    this.addSql(`create table \`llm_providers\` (
      \`id\` text not null,
      \`project_id\` text not null,
      \`name\` text not null,
      \`kind\` text not null,
      \`base_url\` text not null,
      \`default_model\` text not null,
      \`description\` text not null,
      \`sealed_api_key\` text null,
      \`created_at\` datetime not null,
      \`updated_at\` datetime not null,
      primary key (\`id\`),
      constraint \`llm_providers_project_id_name_unique\` unique (\`project_id\`, \`name\`)
    );`);
    this.addSql(`create table \`llm_summary_settings\` (
      \`project_id\` text not null,
      \`provider_id\` text null,
      \`prompt_name\` text null,
      \`prompt_version\` integer null,
      \`updated_at\` datetime not null,
      primary key (\`project_id\`)
    );`);
    // SQLite adds one column per statement.
    for (const columnDefinition of SUMMARY_COLUMNS) {
      this.addSql(`alter table \`evaluation_runs\` add column ${columnDefinition};`);
    }
    this.addSql(
      `create index \`evaluation_runs_summary_status_summary_requested_at_index\` on \`evaluation_runs\` (\`summary_status\`, \`summary_requested_at\`);`,
    );
    // Runs that finished before LLM Summaries existed have none.
    this.addSql(
      "update `evaluation_runs` set `summary_status` = 'not_configured' where `status` = 'finished';",
    );
  }
}
