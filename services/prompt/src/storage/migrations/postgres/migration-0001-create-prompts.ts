import { Migration } from "@mikro-orm/migrations";

export class Migration0001CreatePrompts extends Migration {
  override up(): void {
    this.addSql(`create table "prompts" (
      "id" varchar(36) not null,
      "project_id" varchar(255) not null,
      "name" varchar(128) not null,
      "description" text not null,
      "latest_version_number" integer not null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"),
      constraint "prompts_project_id_name_unique" unique ("project_id", "name")
    );`);
    this.addSql(
      `create index "prompts_project_id_updated_at_index" on "prompts" ("project_id", "updated_at");`,
    );
    this.addSql(`create table "prompt_versions" (
      "prompt_id" varchar(36) not null,
      "version_number" integer not null,
      "template_type" varchar(16) not null,
      "text" text null,
      "messages" jsonb null,
      "model_parameters" jsonb not null,
      "variables" jsonb not null,
      "commit_message" text null,
      "created_at" timestamptz not null,
      primary key ("prompt_id", "version_number"),
      constraint "prompt_versions_prompt_id_foreign" foreign key ("prompt_id")
        references "prompts" ("id") on delete cascade
    );`);
    this.addSql(`create table "prompt_labels" (
      "prompt_id" varchar(36) not null,
      "name" varchar(64) not null,
      "version_number" integer not null,
      "updated_at" timestamptz not null,
      primary key ("prompt_id", "name"),
      constraint "prompt_labels_version_foreign" foreign key ("prompt_id", "version_number")
        references "prompt_versions" ("prompt_id", "version_number") on delete cascade
    );`);
  }
}
