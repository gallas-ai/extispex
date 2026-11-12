import { registerServiceMigrationTests } from "@extispex/service-storage/testing";
import { migrateTelemetryDatabase, openTelemetryDatabase } from "../src/create-service.ts";

registerServiceMigrationTests({
  serviceName: "telemetry",
  openDatabase: openTelemetryDatabase,
  migrateDatabase: migrateTelemetryDatabase,
  tableName: "spans",
});
