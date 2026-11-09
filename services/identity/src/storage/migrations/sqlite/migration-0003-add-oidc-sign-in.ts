import { Migration } from "@mikro-orm/migrations";

export class Migration0003AddOidcSignIn extends Migration {
  override up(): void {
    this.addSql(`alter table \`users\` add column \`oidc_issuer\` text null;`);
    this.addSql(`alter table \`users\` add column \`oidc_subject\` text null;`);
    this.addSql(
      `create unique index \`users_oidc_issuer_oidc_subject_unique\`
        on \`users\` (\`oidc_issuer\`, \`oidc_subject\`);`,
    );
    this.addSql(
      `alter table \`group_members\`
        add column \`is_from_company_group\` integer not null default 0;`,
    );
    this.addSql(`create table \`company_group_mappings\` (
      \`company_group_name\` text not null,
      \`group_id\` text not null,
      primary key (\`company_group_name\`, \`group_id\`),
      constraint \`company_group_mappings_group_id_foreign\` foreign key (\`group_id\`)
        references \`groups\` (\`id\`) on delete cascade
    );`);
    this.addSql(
      `create index \`company_group_mappings_group_id_index\`
        on \`company_group_mappings\` (\`group_id\`);`,
    );
    this.addSql(`create table \`oidc_sign_in_attempts\` (
      \`state_hash\` text not null,
      \`browser_binding_hash\` text not null,
      \`nonce\` text not null,
      \`code_verifier\` text not null,
      \`return_to\` text not null,
      \`expires_at\` datetime not null,
      primary key (\`state_hash\`)
    );`);
    this.addSql(`create table \`sign_in_throttles\` (
      \`key_hash\` text not null,
      \`attempt_count\` integer not null,
      \`window_ends_at_epoch_seconds\` integer not null,
      primary key (\`key_hash\`)
    );`);
  }
}
