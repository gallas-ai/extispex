import { Migration } from "@mikro-orm/migrations";

/** The same as on PostgreSQL. */
export class Migration0005AddDataLifecycle extends Migration {
  override up(): void {
    this.addSql("alter table `projects` add column `retention_days` integer not null default 30;");
    this.addSql(`create table \`project_data_removals\` (
      \`project_id\` text not null,
      \`service\` text not null,
      \`removed_at\` datetime not null,
      primary key (\`project_id\`, \`service\`),
      constraint \`project_data_removals_project_id_foreign\` foreign key (\`project_id\`)
        references \`projects\` (\`id\`) on delete cascade
    );`);
    this.addSql("alter table `users` add column `personal_data_deleted_at` datetime null;");
    this.addSql(
      "create index `users_deactivated_at_index` on `users` (`deactivated_at`) " +
        "where `deactivated_at` is not null and `personal_data_deleted_at` is null;",
    );
    this.addSql(`create table \`background_leases\` (
      \`name\` text not null,
      \`holder\` text not null,
      \`expires_at_epoch_milliseconds\` integer not null,
      primary key (\`name\`)
    );`);
  }
}
