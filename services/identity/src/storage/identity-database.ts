import {
  type DatabaseMigrationMode,
  migrateServiceDatabase,
  openServiceDatabase,
  type ServiceDatabase,
  type ServiceDatabaseDefinition,
} from "@extispex/service-storage";
import { Migration0001CreateProjects as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-projects.ts";
import { Migration0002CreateAccess as PostgresMigration0002 } from "./migrations/postgres/migration-0002-create-access.ts";
import { Migration0003AddOidcSignIn as PostgresMigration0003 } from "./migrations/postgres/migration-0003-add-oidc-sign-in.ts";
import { Migration0004AddDirectorySync as PostgresMigration0004 } from "./migrations/postgres/migration-0004-add-directory-sync.ts";
import { Migration0005AddDataLifecycle as PostgresMigration0005 } from "./migrations/postgres/migration-0005-add-data-lifecycle.ts";
import { Migration0001CreateProjects as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-projects.ts";
import { Migration0002CreateAccess as SqliteMigration0002 } from "./migrations/sqlite/migration-0002-create-access.ts";
import { Migration0003AddOidcSignIn as SqliteMigration0003 } from "./migrations/sqlite/migration-0003-add-oidc-sign-in.ts";
import { Migration0004AddDirectorySync as SqliteMigration0004 } from "./migrations/sqlite/migration-0004-add-directory-sync.ts";
import { Migration0005AddDataLifecycle as SqliteMigration0005 } from "./migrations/sqlite/migration-0005-add-data-lifecycle.ts";
import {
  ApiKeyRecord,
  CompanyGroupMappingRecord,
  CompanyGroupMemberRecord,
  CompanyGroupRecord,
  DirectoryImportRecord,
  DirectoryTokenRecord,
  GroupMemberRecord,
  GroupRecord,
  OidcSignInAttemptRecord,
  ProjectDataRemovalRecord,
  ProjectRecord,
  RoleAssignmentRecord,
  SigningKeyRecord,
  SignInRecord,
  SignInThrottleRecord,
  UserRecord,
} from "./identity-entities.ts";

export type IdentityDatabase = ServiceDatabase;

const IDENTITY_DATABASE: ServiceDatabaseDefinition = {
  entities: [
    ProjectRecord,
    ProjectDataRemovalRecord,
    ApiKeyRecord,
    UserRecord,
    GroupRecord,
    GroupMemberRecord,
    RoleAssignmentRecord,
    SignInRecord,
    SigningKeyRecord,
    CompanyGroupMappingRecord,
    CompanyGroupRecord,
    CompanyGroupMemberRecord,
    DirectoryTokenRecord,
    DirectoryImportRecord,
    OidcSignInAttemptRecord,
    SignInThrottleRecord,
  ],
  migrationsByDialect: {
    postgresql: [
      { name: "0001-create-projects", class: PostgresMigration0001 },
      { name: "0002-create-access", class: PostgresMigration0002 },
      { name: "0003-add-oidc-sign-in", class: PostgresMigration0003 },
      { name: "0004-add-directory-sync", class: PostgresMigration0004 },
      { name: "0005-add-data-lifecycle", class: PostgresMigration0005 },
    ],
    sqlite: [
      { name: "0001-create-projects", class: SqliteMigration0001 },
      { name: "0002-create-access", class: SqliteMigration0002 },
      { name: "0003-add-oidc-sign-in", class: SqliteMigration0003 },
      { name: "0004-add-directory-sync", class: SqliteMigration0004 },
      { name: "0005-add-data-lifecycle", class: SqliteMigration0005 },
    ],
  },
};

/**
 * Opens the Identity database. `apply` creates it when it is missing and applies pending migrations;
 * `check` refuses it while a migration is pending, see `DatabaseMigrationMode`.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export function openIdentityDatabase(
  databaseUrl: string,
  migrations: DatabaseMigrationMode = "apply",
): Promise<IdentityDatabase> {
  return openServiceDatabase({ databaseUrl, migrations, ...IDENTITY_DATABASE });
}

/** The `migrate` command: applies pending migrations and returns their names. */
export function migrateIdentityDatabase(databaseUrl: string): Promise<string[]> {
  return migrateServiceDatabase({ databaseUrl, ...IDENTITY_DATABASE });
}
