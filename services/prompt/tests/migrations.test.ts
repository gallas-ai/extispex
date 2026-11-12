import { registerServiceMigrationTests } from "@extispex/service-storage/testing";
import { migratePromptDatabase, openPromptDatabase } from "../src/create-service.ts";

registerServiceMigrationTests({
  serviceName: "prompt",
  openDatabase: openPromptDatabase,
  migrateDatabase: migratePromptDatabase,
  tableName: "prompts",
});
