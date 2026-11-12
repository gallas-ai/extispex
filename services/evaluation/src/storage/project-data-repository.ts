import type { EvaluationDatabase } from "./evaluation-database.ts";

/**
 * Each table with a Project's rows, children first, with the condition that finds them, so that
 * removal does not depend on foreign keys being enforced.
 */
const PROJECT_ROW_CONDITIONS: [tableName: string, condition: string][] = [
  ["report_deliveries", "run_id in (select id from evaluation_runs where project_id = ?)"],
  [
    "iteration_attempt_steps",
    `iteration_id in (select id from iterations where run_id in
      (select id from evaluation_runs where project_id = ?))`,
  ],
  [
    "iteration_attempts",
    `iteration_id in (select id from iterations where run_id in
      (select id from evaluation_runs where project_id = ?))`,
  ],
  ["iterations", "run_id in (select id from evaluation_runs where project_id = ?)"],
  ["run_test_cases", "run_id in (select id from evaluation_runs where project_id = ?)"],
  ["evaluation_runs", "project_id = ?"],
  ["test_cases", "dataset_id in (select id from datasets where project_id = ?)"],
  ["datasets", "project_id = ?"],
  ["targets", "project_id = ?"],
  ["report_settings", "project_id = ?"],
  ["llm_summary_settings", "project_id = ?"],
  ["llm_providers", "project_id = ?"],
];

/**
 * Deletes every Dataset, Evaluation Run with its results and Report Deliveries, Target, LLM
 * provider and the Report settings of a deleted Project, in one transaction. Queued jobs of its runs
 * find nothing and end.
 */
export async function removeEvaluationProjectData(
  database: EvaluationDatabase,
  projectId: string,
): Promise<void> {
  await database.orm.em.fork().transactional(async (entityManager) => {
    for (const [tableName, condition] of PROJECT_ROW_CONDITIONS) {
      await entityManager.execute(`delete from ${tableName} where ${condition}`, [projectId]);
    }
  });
}
