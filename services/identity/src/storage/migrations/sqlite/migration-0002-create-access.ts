import { Migration } from "@mikro-orm/migrations";

export class Migration0002CreateAccess extends Migration {
  override up(): void {
    this.addSql(`create table \`users\` (
      \`id\` text not null,
      \`email\` text not null,
      \`display_name\` text not null,
      \`password_hash\` text null,
      \`is_instance_admin\` integer not null,
      \`created_at\` datetime not null,
      \`deactivated_at\` datetime null,
      primary key (\`id\`),
      constraint \`users_email_unique\` unique (\`email\`)
    );`);
    this.addSql(`create table \`groups\` (
      \`id\` text not null,
      \`name\` text not null,
      \`created_at\` datetime not null,
      primary key (\`id\`),
      constraint \`groups_name_unique\` unique (\`name\`)
    );`);
    this.addSql(`create table \`group_members\` (
      \`group_id\` text not null,
      \`user_id\` text not null,
      \`added_at\` datetime not null,
      primary key (\`group_id\`, \`user_id\`),
      constraint \`group_members_group_id_foreign\` foreign key (\`group_id\`)
        references \`groups\` (\`id\`) on delete cascade,
      constraint \`group_members_user_id_foreign\` foreign key (\`user_id\`)
        references \`users\` (\`id\`) on delete cascade
    );`);
    this.addSql(`create index \`group_members_user_id_index\` on \`group_members\` (\`user_id\`);`);
    this.addSql(`create table \`role_assignments\` (
      \`project_id\` text not null,
      \`group_id\` text not null,
      \`role\` text not null,
      \`assigned_at\` datetime not null,
      primary key (\`project_id\`, \`group_id\`),
      constraint \`role_assignments_project_id_foreign\` foreign key (\`project_id\`)
        references \`projects\` (\`id\`) on delete cascade,
      constraint \`role_assignments_group_id_foreign\` foreign key (\`group_id\`)
        references \`groups\` (\`id\`) on delete cascade
    );`);
    this.addSql(
      `create index \`role_assignments_group_id_index\` on \`role_assignments\` (\`group_id\`);`,
    );
    this.addSql(`create table \`sign_ins\` (
      \`id\` text not null,
      \`user_id\` text not null,
      \`token_hash\` text not null,
      \`created_at\` datetime not null,
      \`expires_at\` datetime not null,
      primary key (\`id\`),
      constraint \`sign_ins_token_hash_unique\` unique (\`token_hash\`),
      constraint \`sign_ins_user_id_foreign\` foreign key (\`user_id\`)
        references \`users\` (\`id\`) on delete cascade
    );`);
    this.addSql(`create index \`sign_ins_user_id_index\` on \`sign_ins\` (\`user_id\`);`);
    this.addSql(`create table \`signing_keys\` (
      \`id\` text not null,
      \`private_key_jwk\` text not null,
      \`public_key_jwk\` text not null,
      \`created_at\` datetime not null,
      primary key (\`id\`)
    );`);
  }
}
