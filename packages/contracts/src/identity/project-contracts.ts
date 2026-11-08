import { z } from "zod";
import { roleSchema } from "./access-contracts.ts";

/** A Project's display name, unique among the Instance's Projects that are not deleted. */
export const projectNameSchema = z.string().trim().min(1).max(64);

/** Says what the key is for, such as "CI pipeline", so that it can be found when revoking it. */
export const apiKeyNameSchema = z.string().trim().min(1).max(64);

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

/** A Project with the caller's Role in it, or null for an Instance admin without a Role there. */
export const accessibleProjectSchema = projectSchema.extend({ role: roleSchema.nullable() });

export const createProjectRequestSchema = z.object({ name: projectNameSchema });

export const listProjectsResponseSchema = z.object({ projects: z.array(accessibleProjectSchema) });

/** A Project API key as listed: never the key itself, which is stored only as a hash. */
export const apiKeySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** The key's first characters, enough to recognise it, such as `extispex_7Hq2kP9x`. */
  keyPrefix: z.string(),
  createdAt: z.string(),
  /** When the key stopped working, or null while it works. */
  revokedAt: z.string().nullable(),
});

export const createApiKeyRequestSchema = z.object({ name: apiKeyNameSchema });

/** A new API key with its secret value, which the API returns only once. */
export const createdApiKeySchema = apiKeySchema.extend({ apiKey: z.string() });

export const listApiKeysResponseSchema = z.object({ apiKeys: z.array(apiKeySchema) });

export type Project = z.infer<typeof projectSchema>;
export type AccessibleProject = z.infer<typeof accessibleProjectSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;
export type ApiKey = z.infer<typeof apiKeySchema>;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;
export type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>;
