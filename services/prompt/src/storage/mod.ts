/** Public entry point of the storage module: the only file other modules import. */
export {
  migratePromptDatabase,
  openPromptDatabase,
  type PromptDatabase,
} from "./prompt-database.ts";
export { createPromptRepository, type PromptRepository } from "./prompt-repository.ts";
