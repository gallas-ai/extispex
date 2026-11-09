import { Migration } from "@mikro-orm/migrations";

export class Migration0003AddOidcSignIn extends Migration {
  override up(): void {
    this.addSql(`alter table "users" add column "oidc_issuer" varchar(255) null;`);
    this.addSql(`alter table "users" add column "oidc_subject" varchar(255) null;`);
    this.addSql(
      `create unique index "users_oidc_issuer_oidc_subject_unique"
        on "users" ("oidc_issuer", "oidc_subject");`,
    );
    this.addSql(
      `alter table "group_members"
        add column "is_from_company_group" boolean not null default false;`,
    );
    this.addSql(`create table "company_group_mappings" (
      "company_group_name" varchar(255) not null,
      "group_id" varchar(36) not null,
      primary key ("company_group_name", "group_id"),
      constraint "company_group_mappings_group_id_foreign" foreign key ("group_id")
        references "groups" ("id") on delete cascade
    );`);
    this.addSql(
      `create index "company_group_mappings_group_id_index"
        on "company_group_mappings" ("group_id");`,
    );
    this.addSql(`create table "oidc_sign_in_attempts" (
      "state_hash" varchar(64) not null,
      "browser_binding_hash" varchar(64) not null,
      "nonce" varchar(255) not null,
      "code_verifier" varchar(255) not null,
      "return_to" text not null,
      "expires_at" timestamptz not null,
      primary key ("state_hash")
    );`);
    this.addSql(`create table "sign_in_throttles" (
      "key_hash" varchar(64) not null,
      "attempt_count" integer not null,
      "window_ends_at_epoch_seconds" bigint not null,
      primary key ("key_hash")
    );`);
  }
}
