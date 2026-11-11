import { Migration } from "@mikro-orm/migrations";

/**
 * Retention Periods, the removal of deleted Projects' data in each service, a deactivated user's
 * deleted personal data, and the lease that lets one replica at a time do the periodic work.
 */
export class Migration0005AddDataLifecycle extends Migration {
  override up(): void {
    this.addSql(
      `alter table "projects" add column "retention_days" integer not null default 30;`,
    );
    this.addSql(`create table "project_data_removals" (
      "project_id" varchar(36) not null,
      "service" varchar(32) not null,
      "removed_at" timestamptz not null,
      primary key ("project_id", "service"),
      constraint "project_data_removals_project_id_foreign" foreign key ("project_id")
        references "projects" ("id") on delete cascade
    );`);
    this.addSql(`alter table "users" add column "personal_data_deleted_at" timestamptz null;`);
    this.addSql(
      `create index "users_deactivated_at_index" on "users" ("deactivated_at")
        where "deactivated_at" is not null and "personal_data_deleted_at" is null;`,
    );
    this.addSql(`create table "background_leases" (
      "name" varchar(64) not null,
      "holder" varchar(64) not null,
      "expires_at_epoch_milliseconds" bigint not null,
      primary key ("name")
    );`);
  }
}
