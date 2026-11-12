import { Migration } from "@mikro-orm/migrations";

/** The same as on PostgreSQL. */
export class Migration0005CreateBackgroundLeases extends Migration {
  override up(): void {
    this.addSql(`create table \`background_leases\` (
      \`name\` text not null,
      \`holder\` text not null,
      \`expires_at_epoch_milliseconds\` integer not null,
      primary key (\`name\`)
    );`);
  }
}
