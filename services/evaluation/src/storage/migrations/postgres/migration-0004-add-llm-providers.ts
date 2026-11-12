import { Migration } from "@mikro-orm/migrations";

export class Migration0004AddLlmProviders extends Migration {
  override up(): void {
    this.addSql(`create table "llm_providers" (
      "id" varchar(36) not null,
      "project_id" varchar(255) not null,
      "name" varchar(128) not null,
      "kind" varchar(32) not null,
      "base_url" text not null,
      "default_model" varchar(200) not null,
      "description" text not null,
      "sealed_api_key" text null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"),
      constraint "llm_providers_project_id_name_unique" unique ("project_id", "name")
    );`);
    this.addSql(`create table "llm_summary_settings" (
      "project_id" varchar(255) not null,
      "provider_id" varchar(36) null,
      "prompt_name" varchar(128) null,
      "prompt_version" integer null,
      "updated_at" timestamptz not null,
      primary key ("project_id")
    );`);
    this.addSql(`alter table "evaluation_runs"
      add column "summary_status" varchar(16) null,
      add column "summary_provider_id" varchar(36) null,
      add column "summary_provider_name" varchar(128) null,
      add column "summary_prompt_name" varchar(128) null,
      add column "summary_prompt_version" integer null,
      add column "summary_text" text null,
      add column "summary_error" text null,
      add column "summary_model" varchar(200) null,
      add column "summary_attempts" integer not null default 0,
      add column "summary_requested_at" timestamptz null,
      add column "summary_generated_at" timestamptz null;`);
    this.addSql(
      `create index "evaluation_runs_summary_status_summary_requested_at_index" on "evaluation_runs" ("summary_status", "summary_requested_at");`,
    );
    // Runs that finished before LLM Summaries existed have none.
    this.addSql(
      `update "evaluation_runs" set "summary_status" = 'not_configured' where "status" = 'finished';`,
    );
  }
}
