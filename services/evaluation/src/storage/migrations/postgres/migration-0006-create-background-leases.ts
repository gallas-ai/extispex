import { Migration } from "@mikro-orm/migrations";

/** The lease that lets one worker at a time remove deleted Projects' data. */
export class Migration0006CreateBackgroundLeases extends Migration {
  override up(): void {
    this.addSql(`create table "background_leases" (
      "name" varchar(64) not null,
      "holder" varchar(64) not null,
      "expires_at_epoch_milliseconds" bigint not null,
      primary key ("name")
    );`);
  }
}
