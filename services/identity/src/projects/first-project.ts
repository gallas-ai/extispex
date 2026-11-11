import type { Project } from "@extispex/contracts";
import { hashApiKey, readKeyPrefix } from "../api-keys/mod.ts";
import { createProjectRepository, type IdentityDatabase } from "../storage/mod.ts";

export const FIRST_PROJECT_NAME = "Default";
const FIRST_API_KEY_NAME = "Created at first start";

/**
 * Gives a fresh Instance its first Project, `Default`, with the given API key. Does nothing once
 * the Instance has any Project, so it can run on every start and on several replicas at once.
 * Resolves to the new Project, or null when there already was one.
 */
export async function createFirstProjectIfNone(
  database: IdentityDatabase,
  apiKey: string,
  createdAt: Date = new Date(),
): Promise<Project | null> {
  const creation = await createProjectRepository(database).createFirstProject(
    FIRST_PROJECT_NAME,
    {
      name: FIRST_API_KEY_NAME,
      keyPrefix: readKeyPrefix(apiKey),
      keyHash: await hashApiKey(apiKey),
    },
    createdAt,
  );
  return creation.status === "created" ? creation.project : null;
}
