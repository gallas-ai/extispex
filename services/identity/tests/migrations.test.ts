import { registerServiceMigrationTests } from "@extispex/service-storage/testing";
import { migrateIdentityDatabase, openIdentityDatabase } from "../src/create-service.ts";

registerServiceMigrationTests({
  serviceName: "identity",
  openDatabase: openIdentityDatabase,
  migrateDatabase: migrateIdentityDatabase,
  tableName: "projects",
});
