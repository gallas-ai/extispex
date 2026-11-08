import { Migration } from "@mikro-orm/migrations";

export class Migration0002CreateAccess extends Migration {
  override up(): void {
    this.addSql(`create table "users" (
      "id" varchar(36) not null,
      "email" varchar(254) not null,
      "display_name" varchar(100) not null,
      "password_hash" varchar(255) null,
      "is_instance_admin" boolean not null,
      "created_at" timestamptz not null,
      "deactivated_at" timestamptz null,
      primary key ("id"),
      constraint "users_email_unique" unique ("email")
    );`);
    this.addSql(`create table "groups" (
      "id" varchar(36) not null,
      "name" varchar(64) not null,
      "created_at" timestamptz not null,
      primary key ("id"),
      constraint "groups_name_unique" unique ("name")
    );`);
    this.addSql(`create table "group_members" (
      "group_id" varchar(36) not null,
      "user_id" varchar(36) not null,
      "added_at" timestamptz not null,
      primary key ("group_id", "user_id"),
      constraint "group_members_group_id_foreign" foreign key ("group_id")
        references "groups" ("id") on delete cascade,
      constraint "group_members_user_id_foreign" foreign key ("user_id")
        references "users" ("id") on delete cascade
    );`);
    this.addSql(`create index "group_members_user_id_index" on "group_members" ("user_id");`);
    this.addSql(`create table "role_assignments" (
      "project_id" varchar(36) not null,
      "group_id" varchar(36) not null,
      "role" varchar(16) not null,
      "assigned_at" timestamptz not null,
      primary key ("project_id", "group_id"),
      constraint "role_assignments_project_id_foreign" foreign key ("project_id")
        references "projects" ("id") on delete cascade,
      constraint "role_assignments_group_id_foreign" foreign key ("group_id")
        references "groups" ("id") on delete cascade
    );`);
    this.addSql(
      `create index "role_assignments_group_id_index" on "role_assignments" ("group_id");`,
    );
    this.addSql(`create table "sign_ins" (
      "id" varchar(36) not null,
      "user_id" varchar(36) not null,
      "token_hash" varchar(64) not null,
      "created_at" timestamptz not null,
      "expires_at" timestamptz not null,
      primary key ("id"),
      constraint "sign_ins_token_hash_unique" unique ("token_hash"),
      constraint "sign_ins_user_id_foreign" foreign key ("user_id")
        references "users" ("id") on delete cascade
    );`);
    this.addSql(`create index "sign_ins_user_id_index" on "sign_ins" ("user_id");`);
    this.addSql(`create table "signing_keys" (
      "id" varchar(36) not null,
      "private_key_jwk" text not null,
      "public_key_jwk" text not null,
      "created_at" timestamptz not null,
      primary key ("id")
    );`);
  }
}
