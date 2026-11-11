import { Migration } from "@mikro-orm/migrations";

export class Migration0005AddReports extends Migration {
  override up(): void {
    this.addSql(`create table \`report_settings\` (
      \`project_id\` text not null,
      \`condition\` text not null,
      \`email_channel\` json null,
      \`sealed_smtp_password\` text null,
      \`sealed_teams_webhook_url\` text null,
      \`teams_webhook_host\` text null,
      \`updated_at\` datetime not null,
      primary key (\`project_id\`)
    );`);
    this.addSql(`create table \`report_deliveries\` (
      \`id\` text not null,
      \`run_id\` text not null,
      \`channel\` text not null,
      \`status\` text not null,
      \`attempt_count\` integer not null,
      \`last_error\` text null,
      \`due_at\` datetime not null,
      \`delivered_at\` datetime null,
      \`created_at\` datetime not null,
      primary key (\`id\`),
      constraint \`report_deliveries_run_id_channel_unique\` unique (\`run_id\`, \`channel\`),
      constraint \`report_deliveries_run_id_foreign\` foreign key (\`run_id\`)
        references \`evaluation_runs\` (\`id\`) on delete cascade
    );`);
    this.addSql(
      `create index \`report_deliveries_status_due_at_index\` on \`report_deliveries\` (\`status\`, \`due_at\`);`,
    );
  }
}
