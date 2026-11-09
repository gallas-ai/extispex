import { Migration } from "@mikro-orm/migrations";

export class Migration0002IndexAttemptTelemetryIds extends Migration {
  override up(): void {
    this.addSql(
      `create index \`iteration_attempts_correlation_id_index\` on \`iteration_attempts\` (\`correlation_id\`);`,
    );
    this.addSql(
      `create index \`iteration_attempts_session_id_index\` on \`iteration_attempts\` (\`session_id\`);`,
    );
  }
}
