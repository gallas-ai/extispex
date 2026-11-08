import { Migration } from "@mikro-orm/migrations";

export class Migration0001CreateEvaluation extends Migration {
  override up(): void {
    this.addSql(`create table "datasets" (
      "id" varchar(36) not null,
      "project_id" varchar(255) not null,
      "name" varchar(128) not null,
      "description" text not null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"),
      constraint "datasets_project_id_name_unique" unique ("project_id", "name")
    );`);
    this.addSql(
      `create index "datasets_project_id_updated_at_index" on "datasets" ("project_id", "updated_at");`,
    );
    this.addSql(`create table "test_cases" (
      "id" varchar(36) not null,
      "dataset_id" varchar(36) not null,
      "name" varchar(128) not null,
      "definition" jsonb not null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"),
      constraint "test_cases_dataset_id_name_unique" unique ("dataset_id", "name"),
      constraint "test_cases_dataset_id_foreign" foreign key ("dataset_id")
        references "datasets" ("id") on delete cascade
    );`);
    this.addSql(`create table "evaluation_runs" (
      "id" varchar(36) not null,
      "project_id" varchar(255) not null,
      "dataset_name" varchar(128) not null,
      "execution_mode" varchar(16) not null,
      "status" varchar(16) not null,
      "verdict" varchar(16) null,
      "batch_size" integer not null,
      "total_iterations" integer not null,
      "revision" integer not null,
      "finish_requested_at" timestamptz null,
      "last_activity_at" timestamptz not null,
      "created_at" timestamptz not null,
      "finished_at" timestamptz null,
      primary key ("id")
    );`);
    this.addSql(
      `create index "evaluation_runs_project_id_created_at_index" on "evaluation_runs" ("project_id", "created_at");`,
    );
    this.addSql(
      `create index "evaluation_runs_status_last_activity_at_index" on "evaluation_runs" ("status", "last_activity_at");`,
    );
    this.addSql(`create table "run_test_cases" (
      "id" varchar(36) not null,
      "run_id" varchar(36) not null,
      "position" integer not null,
      "name" varchar(128) not null,
      "definition" jsonb not null,
      "outcome" varchar(16) null,
      primary key ("id"),
      constraint "run_test_cases_run_id_position_unique" unique ("run_id", "position"),
      constraint "run_test_cases_run_id_foreign" foreign key ("run_id")
        references "evaluation_runs" ("id") on delete cascade
    );`);
    this.addSql(`create table "iterations" (
      "id" varchar(36) not null,
      "run_id" varchar(36) not null,
      "run_test_case_id" varchar(36) not null,
      "sequence" integer not null,
      "iteration_number" integer not null,
      "status" varchar(16) not null,
      "current_attempt" integer not null,
      "evaluation_requested_at" timestamptz null,
      primary key ("id"),
      constraint "iterations_run_id_sequence_unique" unique ("run_id", "sequence"),
      constraint "iterations_run_test_case_id_iteration_number_unique"
        unique ("run_test_case_id", "iteration_number"),
      constraint "iterations_run_id_foreign" foreign key ("run_id")
        references "evaluation_runs" ("id") on delete cascade,
      constraint "iterations_run_test_case_id_foreign" foreign key ("run_test_case_id")
        references "run_test_cases" ("id") on delete cascade
    );`);
    this.addSql(
      `create index "iterations_run_id_status_sequence_index" on "iterations" ("run_id", "status", "sequence");`,
    );
    this.addSql(
      `create index "iterations_status_evaluation_requested_at_index" on "iterations" ("status", "evaluation_requested_at");`,
    );
    this.addSql(`create table "iteration_attempts" (
      "iteration_id" varchar(36) not null,
      "attempt_number" integer not null,
      "outcome" varchar(16) null,
      "output" text null,
      "error" text null,
      "correlation_id" varchar(256) null,
      "session_id" varchar(256) null,
      "evaluator_results" jsonb not null,
      "reported_at" timestamptz not null,
      "evaluated_at" timestamptz null,
      primary key ("iteration_id", "attempt_number"),
      constraint "iteration_attempts_iteration_id_foreign" foreign key ("iteration_id")
        references "iterations" ("id") on delete cascade
    );`);
  }
}
