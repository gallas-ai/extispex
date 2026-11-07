import { Migration } from "@mikro-orm/migrations";

export class Migration0001CreatePrompts extends Migration {
  override up(): void {
    this.addSql(`create table \`prompts\` (
      \`id\` text not null,
      \`project_id\` text not null,
      \`name\` text not null,
      \`description\` text not null,
      \`latest_version_number\` integer not null,
      \`created_at\` datetime not null,
      \`updated_at\` datetime not null,
      primary key (\`id\`),
      constraint \`prompts_project_id_name_unique\` unique (\`project_id\`, \`name\`)
    );`);
    this.addSql(
      "create index `prompts_project_id_updated_at_index` on `prompts` (`project_id`, `updated_at`);",
    );
    this.addSql(`create table \`prompt_versions\` (
      \`prompt_id\` text not null,
      \`version_number\` integer not null,
      \`template_type\` text not null,
      \`text\` text null,
      \`messages\` json null,
      \`model_parameters\` json not null,
      \`variables\` json not null,
      \`commit_message\` text null,
      \`created_at\` datetime not null,
      primary key (\`prompt_id\`, \`version_number\`),
      constraint \`prompt_versions_prompt_id_foreign\` foreign key (\`prompt_id\`)
        references \`prompts\` (\`id\`) on delete cascade
    );`);
    this.addSql(`create table \`prompt_labels\` (
      \`prompt_id\` text not null,
      \`name\` text not null,
      \`version_number\` integer not null,
      \`updated_at\` datetime not null,
      primary key (\`prompt_id\`, \`name\`),
      constraint \`prompt_labels_version_foreign\` foreign key (\`prompt_id\`, \`version_number\`)
        references \`prompt_versions\` (\`prompt_id\`, \`version_number\`) on delete cascade
    );`);
  }
}
