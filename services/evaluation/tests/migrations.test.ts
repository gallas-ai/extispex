import { registerServiceMigrationTests } from "@extispex/service-storage/testing";
import { migrateEvaluationDatabase, openEvaluationDatabase } from "../src/create-service.ts";

registerServiceMigrationTests({
  serviceName: "evaluation",
  openDatabase: openEvaluationDatabase,
  migrateDatabase: migrateEvaluationDatabase,
  tableName: "datasets",
});
