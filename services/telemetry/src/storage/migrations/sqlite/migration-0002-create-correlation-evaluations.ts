import { Migration } from "@mikro-orm/migrations";

export class Migration0002CreateCorrelationEvaluations extends Migration {
  override up(): void {
    this.addSql(`create table \`correlation_evaluations\` (
      \`project_id\` text not null,
      \`correlation_id\` text not null,
      \`evaluated_at\` datetime not null,
      primary key (\`project_id\`, \`correlation_id\`)
    );`);
  }
}
