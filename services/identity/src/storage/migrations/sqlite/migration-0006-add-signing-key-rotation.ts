import { Migration } from "@mikro-orm/migrations";

/**
 * Rotating the signing key: which key signs, chosen by the latest activation, and when a replaced
 * key retired, after which it stays published until every token it signed has expired.
 */
export class Migration0006AddSigningKeyRotation extends Migration {
  override up(): void {
    this.addSql("alter table `signing_keys` add column `activated_at` datetime null;");
    this.addSql("alter table `signing_keys` add column `retired_at` datetime null;");
  }
}
