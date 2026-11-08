import type { User } from "@extispex/contracts";
import type { IdentityDatabase } from "../storage/identity-database.ts";
import { createAccessRepository } from "../storage/access-repository.ts";
import { DEFAULT_PASSWORD_HASH_ITERATIONS, hashPassword } from "./password-hashing.ts";

/** The first administrator's address in the local image, unless `BOOTSTRAP_ADMIN_EMAIL` is set. */
export const DEFAULT_FIRST_ADMINISTRATOR_EMAIL = "admin@extispex.local";

export interface FirstAdministrator {
  email: string;
  password: string;
}

/**
 * Gives a fresh Instance its first user: an Instance admin with a local account, in the Group
 * `Administrators`, which gets the Role `admin` in every Project that exists, such as `Default`.
 * Does nothing once the Instance has any user, so it can run on every start and on several
 * replicas at once. Resolves to the new user, or null when there already was one.
 */
export async function createFirstAdministratorIfNone(
  database: IdentityDatabase,
  firstAdministrator: FirstAdministrator,
  options: { passwordHashIterations?: number; createdAt?: Date } = {},
): Promise<User | null> {
  const accessRepository = createAccessRepository(database);
  if ((await accessRepository.listUsers()).length > 0) return null;
  return await accessRepository.createFirstAdministrator({
    email: firstAdministrator.email.trim().toLowerCase(),
    displayName: "Administrator",
    passwordHash: await hashPassword(
      firstAdministrator.password,
      options.passwordHashIterations ?? DEFAULT_PASSWORD_HASH_ITERATIONS,
    ),
    isInstanceAdmin: true,
  }, options.createdAt ?? new Date());
}
