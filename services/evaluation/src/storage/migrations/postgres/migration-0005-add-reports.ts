import { Migration } from "@mikro-orm/migrations";

export class Migration0005AddReports extends Migration {
  override up(): void {
    this.addSql(`create table "report_settings" (
      "project_id" varchar(255) not null,
      "condition" varchar(32) not null,
      "email_channel" jsonb null,
      "sealed_smtp_password" text null,
      "sealed_teams_webhook_url" text null,
      "teams_webhook_host" varchar(255) null,
      "updated_at" timestamptz not null,
      primary key ("project_id")
    );`);
    this.addSql(`create table "report_deliveries" (
      "id" varchar(36) not null,
      "run_id" varchar(36) not null,
      "channel" varchar(16) not null,
      "status" varchar(16) not null,
      "attempt_count" integer not null,
      "last_error" text null,
      "due_at" timestamptz not null,
      "delivered_at" timestamptz null,
      "created_at" timestamptz not null,
      primary key ("id"),
      constraint "report_deliveries_run_id_channel_unique" unique ("run_id", "channel"),
      constraint "report_deliveries_run_id_foreign" foreign key ("run_id")
        references "evaluation_runs" ("id") on delete cascade
    );`);
    this.addSql(
      `create index "report_deliveries_status_due_at_index" on "report_deliveries" ("status", "due_at");`,
    );
  }
}
