import { Migration } from "@mikro-orm/migrations";

export class Migration0004AddDirectorySync extends Migration {
  override up(): void {
    this.addSql(`alter table "users" add column "directory_source" varchar(16) null;`);
    this.addSql(`alter table "users" add column "directory_user_name" varchar(255) null;`);
    this.addSql(`alter table "users" add column "directory_external_id" varchar(255) null;`);
    this.addSql(`alter table "users" add column "directory_removed_at" timestamptz null;`);
    this.addSql(
      `create unique index "users_directory_user_name_unique" on "users" ("directory_user_name");`,
    );
    this.addSql(`create table "company_groups" (
      "id" varchar(36) not null,
      "display_name" varchar(255) not null,
      "external_id" varchar(255) null,
      "source" varchar(16) not null,
      "created_at" timestamptz not null,
      primary key ("id"),
      constraint "company_groups_display_name_unique" unique ("display_name")
    );`);
    this.addSql(
      `create index "company_groups_external_id_index" on "company_groups" ("external_id");`,
    );
    this.addSql(`create table "company_group_members" (
      "company_group_id" varchar(36) not null,
      "user_id" varchar(36) not null,
      "added_at" timestamptz not null,
      primary key ("company_group_id", "user_id"),
      constraint "company_group_members_company_group_id_foreign" foreign key ("company_group_id")
        references "company_groups" ("id") on delete cascade,
      constraint "company_group_members_user_id_foreign" foreign key ("user_id")
        references "users" ("id") on delete cascade
    );`);
    this.addSql(
      `create index "company_group_members_user_id_index" on "company_group_members" ("user_id");`,
    );
    this.addSql(`create table "directory_tokens" (
      "id" varchar(36) not null,
      "name" varchar(64) not null,
      "token_prefix" varchar(32) not null,
      "token_hash" varchar(64) not null,
      "created_at" timestamptz not null,
      "last_used_at" timestamptz null,
      "revoked_at" timestamptz null,
      primary key ("id"),
      constraint "directory_tokens_token_hash_unique" unique ("token_hash")
    );`);
    this.addSql(`create table "directory_imports" (
      "id" varchar(36) not null,
      "imported_at" timestamptz not null,
      "imported_by_user_id" varchar(36) not null,
      "format" varchar(8) not null,
      "row_count" integer not null,
      "created_count" integer not null,
      "updated_count" integer not null,
      "deactivated_count" integer not null,
      "unchanged_count" integer not null,
      primary key ("id")
    );`);
  }
}
