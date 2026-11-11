/** Public entry point of the accounts module: the only file other modules import. */
export {
  createFirstAdministratorIfNone,
  DEFAULT_FIRST_ADMINISTRATOR_EMAIL,
  type FirstAdministrator,
} from "./first-administrator.ts";
export {
  createDecoyPasswordHash,
  DEFAULT_PASSWORD_HASH_ITERATIONS,
  hashPassword,
  verifyPassword,
} from "./password-hashing.ts";
export { parseServiceClients } from "./service-clients.ts";
