import { openServiceDatabase, type ServiceDatabase } from "@extispex/service-storage";
import { Migration0001CreateProjects as PostgresMigration0001 } from "./migrations/postgres/migration-0001-create-projects.ts";
import { Migration0002CreateAccess as PostgresMigration0002 } from "./migrations/postgres/migration-0002-create-access.ts";
import { Migration0003AddOidcSignIn as PostgresMigration0003 } from "./migrations/postgres/migration-0003-add-oidc-sign-in.ts";
import { Migration0001CreateProjects as SqliteMigration0001 } from "./migrations/sqlite/migration-0001-create-projects.ts";
import { Migration0002CreateAccess as SqliteMigration0002 } from "./migrations/sqlite/migration-0002-create-access.ts";
import { Migration0003AddOidcSignIn as SqliteMigration0003 } from "./migrations/sqlite/migration-0003-add-oidc-sign-in.ts";
import {
  ApiKeyRecord,
  CompanyGroupMappingRecord,
  GroupMemberRecord,
  GroupRecord,
  OidcSignInAttemptRecord,
  ProjectRecord,
  RoleAssignmentRecord,
  SigningKeyRecord,
  SignInRecord,
  SignInThrottleRecord,
  UserRecord,
} from "./identity-entities.ts";

export type IdentityDatabase = ServiceDatabase;

/**
 * Opens the Identity database and applies pending migrations.
 *
 * Accepts `postgresql://…` or `postgres://…` for PostgreSQL, and `sqlite:<file path>` or
 * `sqlite::memory:` for SQLite.
 */
export function openIdentityDatabase(databaseUrl: string): Promise<IdentityDatabase> {
  return openServiceDatabase({
    databaseUrl,
    entities: [
      ProjectRecord,
      ApiKeyRecord,
      UserRecord,
      GroupRecord,
      GroupMemberRecord,
      RoleAssignmentRecord,
      SignInRecord,
      SigningKeyRecord,
      CompanyGroupMappingRecord,
      OidcSignInAttemptRecord,
      SignInThrottleRecord,
    ],
    migrationsByDialect: {
      postgresql: [
        { name: "0001-create-projects", class: PostgresMigration0001 },
        { name: "0002-create-access", class: PostgresMigration0002 },
        { name: "0003-add-oidc-sign-in", class: PostgresMigration0003 },
      ],
      sqlite: [
        { name: "0001-create-projects", class: SqliteMigration0001 },
        { name: "0002-create-access", class: SqliteMigration0002 },
        { name: "0003-add-oidc-sign-in", class: SqliteMigration0003 },
      ],
    },
  });
}
