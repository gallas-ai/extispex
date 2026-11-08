import { assertEquals } from "@std/assert";
import { listTestDatabases } from "@extispex/service-storage/testing";
import { replacePostgresDatabaseName } from "@extispex/service-storage";
import { openEvaluationDatabase } from "../src/create-service.ts";

const postgresDatabase = listTestDatabases("evaluation").find((testDatabase) =>
  testDatabase.label === "postgresql"
);

Deno.test({
  name: "replicas that start together create and migrate one database (postgresql)",
  ignore: postgresDatabase === undefined,
  fn: async () => {
    const databaseName = `evaluation_start_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrl = replacePostgresDatabaseName(postgresDatabase!.url, databaseName);
    const databases = await Promise.all(
      Array.from({ length: 5 }, () => openEvaluationDatabase(databaseUrl)),
    );
    try {
      const [{ count }] = await databases[0].orm.em.fork().execute(
        "select count(*)::int as count from datasets",
      );
      assertEquals(count, 0);
    } finally {
      await Promise.all(databases.map((database) => database.close()));
      const administration = await openEvaluationDatabase(postgresDatabase!.url);
      await administration.orm.em.fork().execute(`drop database "${databaseName}"`);
      await administration.close();
    }
  },
});
