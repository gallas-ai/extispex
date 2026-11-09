import { Migration } from "@mikro-orm/migrations";

export class Migration0002CreateCorrelationEvaluations extends Migration {
  override up(): void {
    this.addSql(`create table "correlation_evaluations" (
      "project_id" varchar(255) not null,
      "correlation_id" text not null,
      "evaluated_at" timestamptz not null,
      primary key ("project_id", "correlation_id")
    );`);
  }
}
