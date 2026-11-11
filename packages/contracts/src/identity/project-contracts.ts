import { z } from "zod";
import { roleSchema } from "./access-contracts.ts";

/** A Project's display name, unique among the Instance's Projects that are not deleted. */
export const projectNameSchema = z.string().trim().min(1).max(64);

/** Says what the key is for, such as "CI pipeline", so that it can be found when revoking it. */
export const apiKeyNameSchema = z.string().trim().min(1).max(64);

/** How long a Project's telemetry is kept unless its admins choose otherwise. */
export const DEFAULT_RETENTION_DAYS = 30;
/** At least a day, so that a retention never deletes telemetry before anyone could look at it. */
export const MINIMUM_RETENTION_DAYS = 1;
export const MAXIMUM_RETENTION_DAYS = 400;

/** How many days a Project's traces, Log Records and metric points are kept, by their own time. */
export const retentionDaysSchema = z.number().int().min(MINIMUM_RETENTION_DAYS).max(
  MAXIMUM_RETENTION_DAYS,
);

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** The Project's Retention Period in days. */
  retentionDays: z.number().int(),
});

/** A Project with the caller's Role in it, or null for an Instance admin without a Role there. */
export const accessibleProjectSchema = projectSchema.extend({ role: roleSchema.nullable() });

export const createProjectRequestSchema = z.object({ name: projectNameSchema });

/** Only the fields present change. */
export const updateProjectRequestSchema = z.object({
  retentionDays: retentionDaysSchema.optional(),
});

/**
 * The services that keep a Project's data, each of which removes it after the Project is deleted.
 * Each one's client ID in Identity's `SERVICE_CLIENTS` is its name; Identity removes its own.
 */
export const PROJECT_DATA_SERVICES = ["identity", "telemetry", "prompt", "evaluation"] as const;
export const projectDataServiceSchema = z.enum(PROJECT_DATA_SERVICES);

/** How far one service has got with removing a deleted Project's data. */
export const projectDataRemovalSchema = z.object({
  service: projectDataServiceSchema,
  /** When the service last removed the Project's data, or null if it has not yet. */
  removedAt: z.string().nullable(),
  /**
   * Whether the data is gone for good: removed after every access token for the Project expired,
   * so nothing can have written more since.
   */
  isComplete: z.boolean(),
});

export const deletedProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  deletedAt: z.string(),
  /** One entry per service in {@link PROJECT_DATA_SERVICES}, in that order. */
  dataRemovals: z.array(projectDataRemovalSchema),
});

export const listDeletedProjectsResponseSchema = z.object({
  deletedProjects: z.array(deletedProjectSchema),
});

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
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type ProjectDataService = z.infer<typeof projectDataServiceSchema>;
export type ProjectDataRemoval = z.infer<typeof projectDataRemovalSchema>;
export type DeletedProject = z.infer<typeof deletedProjectSchema>;
export type ListDeletedProjectsResponse = z.infer<typeof listDeletedProjectsResponseSchema>;
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;
export type ApiKey = z.infer<typeof apiKeySchema>;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;
export type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>;
