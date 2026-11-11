import { Migration } from "@mikro-orm/migrations";

export class Migration0003AddServerDrivenExecution extends Migration {
  override up(): void {
    this.addSql(`create table \`targets\` (
      \`id\` text not null,
      \`project_id\` text not null,
      \`name\` text not null,
      \`url\` text not null,
      \`description\` text not null,
      \`credential_header_name\` text null,
      \`sealed_credential_value\` text null,
      \`created_at\` datetime not null,
      \`updated_at\` datetime not null,
      primary key (\`id\`),
      constraint \`targets_project_id_name_unique\` unique (\`project_id\`, \`name\`)
    );`);
    this.addSql(`alter table \`evaluation_runs\` add column \`target_id\` text null;`);
    this.addSql(`alter table \`evaluation_runs\` add column \`target_name\` text null;`);
    this.addSql(`alter table \`iterations\` add column \`execution_heartbeat_at\` datetime null;`);
    this.addSql(`create table \`iteration_attempt_steps\` (
      \`iteration_id\` text not null,
      \`attempt_number\` integer not null,
      \`step_number\` integer not null,
      \`output\` text not null,
      \`correlation_id\` text not null,
      \`session_id\` text not null,
      primary key (\`iteration_id\`, \`attempt_number\`, \`step_number\`),
      constraint \`iteration_attempt_steps_attempt_foreign\`
        foreign key (\`iteration_id\`, \`attempt_number\`)
        references \`iteration_attempts\` (\`iteration_id\`, \`attempt_number\`) on delete cascade
    );`);
    this.addSql(
      `create index \`iteration_attempt_steps_correlation_id_index\` on \`iteration_attempt_steps\` (\`correlation_id\`);`,
    );
    this.addSql(
      `create index \`iteration_attempt_steps_session_id_index\` on \`iteration_attempt_steps\` (\`session_id\`);`,
    );
  }
}
