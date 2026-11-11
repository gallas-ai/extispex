import { Migration } from "@mikro-orm/migrations";

export class Migration0004AddDirectorySync extends Migration {
  override up(): void {
    this.addSql(`alter table \`users\` add column \`directory_source\` text null;`);
    this.addSql(`alter table \`users\` add column \`directory_user_name\` text null;`);
    this.addSql(`alter table \`users\` add column \`directory_external_id\` text null;`);
    this.addSql(`alter table \`users\` add column \`directory_removed_at\` datetime null;`);
    this.addSql(
      `create unique index \`users_directory_user_name_unique\`
        on \`users\` (\`directory_user_name\`);`,
    );
    this.addSql(`create table \`company_groups\` (
      \`id\` text not null,
      \`display_name\` text not null,
      \`external_id\` text null,
      \`source\` text not null,
      \`created_at\` datetime not null,
      primary key (\`id\`),
      constraint \`company_groups_display_name_unique\` unique (\`display_name\`)
    );`);
    this.addSql(
      `create index \`company_groups_external_id_index\` on \`company_groups\` (\`external_id\`);`,
    );
    this.addSql(`create table \`company_group_members\` (
      \`company_group_id\` text not null,
      \`user_id\` text not null,
      \`added_at\` datetime not null,
      primary key (\`company_group_id\`, \`user_id\`),
      constraint \`company_group_members_company_group_id_foreign\` foreign key (\`company_group_id\`)
        references \`company_groups\` (\`id\`) on delete cascade,
      constraint \`company_group_members_user_id_foreign\` foreign key (\`user_id\`)
        references \`users\` (\`id\`) on delete cascade
    );`);
    this.addSql(
      `create index \`company_group_members_user_id_index\`
        on \`company_group_members\` (\`user_id\`);`,
    );
    this.addSql(`create table \`directory_tokens\` (
      \`id\` text not null,
      \`name\` text not null,
      \`token_prefix\` text not null,
      \`token_hash\` text not null,
      \`created_at\` datetime not null,
      \`last_used_at\` datetime null,
      \`revoked_at\` datetime null,
      primary key (\`id\`),
      constraint \`directory_tokens_token_hash_unique\` unique (\`token_hash\`)
    );`);
    this.addSql(`create table \`directory_imports\` (
      \`id\` text not null,
      \`imported_at\` datetime not null,
      \`imported_by_user_id\` text not null,
      \`format\` text not null,
      \`row_count\` integer not null,
      \`created_count\` integer not null,
      \`updated_count\` integer not null,
      \`deactivated_count\` integer not null,
      \`unchanged_count\` integer not null,
      primary key (\`id\`)
    );`);
  }
}
