import { replacePostgresDatabaseName } from "./service-database.ts";

/** The variable that points the tests at a PostgreSQL server, such as `postgresql://user:pw@host`. */
export const TEST_POSTGRES_URL_VARIABLE = "TEST_POSTGRES_URL";

export interface TestDatabase {
  /** `sqlite` or `postgresql`, for test names. */
  label: string;
  url: string;
}

/**
 * The databases a service's storage tests run on: SQLite always, and PostgreSQL when
 * `TEST_POSTGRES_URL` is set. Each service gets its own database `<service>_test` on that server,
 * created on first use, so the services' tests never share tables.
 */
export function listTestDatabases(serviceName: string): TestDatabase[] {
  const testDatabases = [{ label: "sqlite", url: "sqlite::memory:" }];
  const postgresServerUrl = Deno.env.get(TEST_POSTGRES_URL_VARIABLE)?.trim();
  if (postgresServerUrl) {
    testDatabases.push({
      label: "postgresql",
      url: replacePostgresDatabaseName(postgresServerUrl, `${serviceName}_test`),
    });
  }
  return testDatabases;
}

export {
  registerServiceMigrationTests,
  type ServiceMigrationTestSubject,
} from "./migration-tests.ts";
