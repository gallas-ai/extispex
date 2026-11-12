import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { describeErrorResponse } from "../openapi-route-parts.ts";

/** A Project that is not deleted, with how long the services keep its telemetry. */
export const projectRetentionSchema = z.object({
  projectId: z.string(),
  retentionDays: z.number().int(),
});

/** A deleted Project whose data the asking service still has to remove. */
export const projectToRemoveSchema = z.object({
  projectId: z.string(),
  deletedAt: z.string(),
});

export const projectLifecycleSchema = z.object({
  /** Every Project that is not deleted. */
  projects: z.array(projectRetentionSchema),
  /**
   * The deleted Projects that the asking service has not yet removed for good: never, or only
   * while an access token for the Project could still have written more.
   */
  projectsToRemove: z.array(projectToRemoveSchema),
});

/**
 * What a service needs for its periodic data work: each Project's Retention Period and the deleted
 * Projects whose data it still has to remove. Internal, like every `/internal/` path, and takes a
 * service token without a Project; the token's client ID names the asking service.
 */
export const readProjectLifecycleRoute = createRoute({
  method: "get",
  path: "/internal/v1/project-lifecycle",
  summary: "Read the Retention Periods and the deleted Projects whose data the service removes.",
  tags: ["Internal"],
  security: [{ accessToken: [] }],
  responses: {
    200: {
      description: "The Projects, and the deleted Projects to remove.",
      content: { "application/json": { schema: projectLifecycleSchema } },
    },
    401: describeErrorResponse("The caller is not a service with a valid service token."),
  },
});

/**
 * A service says that it has removed a deleted Project's data, at the time of the request. It
 * takes a service token without a Project, and the token's client ID names the service.
 */
export const recordProjectDataRemovalRoute = createRoute({
  method: "put",
  path: "/internal/v1/deleted-projects/{projectId}/data-removal",
  summary: "Record that the calling service has removed a deleted Project's data.",
  tags: ["Internal"],
  security: [{ accessToken: [] }],
  request: { params: z.object({ projectId: z.string().min(1).max(64) }) },
  responses: {
    204: { description: "Recorded." },
    401: describeErrorResponse("The caller is not a service with a valid service token."),
    403: describeErrorResponse("The calling service keeps no Project data."),
    404: describeErrorResponse("No deleted Project has this ID."),
  },
});

export type ProjectRetention = z.infer<typeof projectRetentionSchema>;
export type ProjectToRemove = z.infer<typeof projectToRemoveSchema>;
export type ProjectLifecycle = z.infer<typeof projectLifecycleSchema>;
