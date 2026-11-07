import { Migration } from "@mikro-orm/migrations";

export class Migration0001CreateProjects extends Migration {
  override up(): void {
    this.addSql(`create table \`projects\` (
      \`id\` text not null,
      \`name\` text not null,
      \`created_at\` datetime not null,
      \`deleted_at\` datetime null,
      primary key (\`id\`)
    );`);
    this.addSql(
      "create unique index `projects_name_unique` on `projects` (`name`) where `deleted_at` is null;",
    );
    this.addSql(`create table \`api_keys\` (
      \`id\` text not null,
      \`project_id\` text not null,
      \`name\` text not null,
      \`key_prefix\` text not null,
      \`key_hash\` text not null,
      \`created_at\` datetime not null,
      \`revoked_at\` datetime null,
      primary key (\`id\`),
      constraint \`api_keys_key_hash_unique\` unique (\`key_hash\`),
      constraint \`api_keys_project_id_foreign\` foreign key (\`project_id\`)
        references \`projects\` (\`id\`) on delete cascade
    );`);
    this.addSql(
      "create index `api_keys_project_id_created_at_index` on `api_keys` (`project_id`, `created_at`);",
    );
  }
}
