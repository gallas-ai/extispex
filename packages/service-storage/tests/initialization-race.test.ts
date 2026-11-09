import { assertEquals } from "@std/assert";
import { MikroORM } from "@mikro-orm/postgresql";
import { isLostInitializationRace } from "../src/initialization-race.ts";
import { replacePostgresDatabaseName } from "../src/service-database.ts";
import { TEST_POSTGRES_URL_VARIABLE } from "../src/test-databases.ts";

const postgresServerUrl = Deno.env.get(TEST_POSTGRES_URL_VARIABLE)?.trim();

async function readFailure(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("The statement was expected to fail.");
}

// The window between checking that a database is missing and creating it is too narrow to hit on
// demand, so these run the failing statements directly, on the path that creating a database takes.
Deno.test({
  name: "recognises only a lost race among PostgreSQL failures (postgresql)",
  ignore: postgresServerUrl === undefined,
  fn: async (testContext) => {
    const orm = await MikroORM.init({
      clientUrl: replacePostgresDatabaseName(postgresServerUrl!, "postgres"),
      entities: [],
      discovery: { warnWhenNoEntities: false },
      debug: false,
    });
    const databaseName = `initialization_race_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await orm.schema.execute(`create database "${databaseName}"`);

      await testContext.step("counts a database that another replica just created", async () => {
        const failure = await readFailure(() =>
          orm.schema.execute(`create database "${databaseName}"`)
        );
        assertEquals(isLostInitializationRace(failure), true);
      });

      await testContext.step("does not count any other failure", async () => {
        const failure = await readFailure(() => orm.schema.execute("select missing_column"));
        assertEquals(isLostInitializationRace(failure), false);
      });
    } finally {
      await orm.schema.execute(`drop database if exists "${databaseName}"`);
      await orm.close(true);
    }
  },
});
