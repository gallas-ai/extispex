import type { ProjectLifecycleSource } from "./project-lifecycle-client.ts";
import type { StructuredLogger } from "./structured-logger.ts";

export interface DeletedProjectRemovalOptions {
  /** Takes or renews this replica's lease, as `BackgroundLease.tryAcquire` does. */
  tryAcquireLease(now: Date): Promise<boolean>;
  projectLifecycle: ProjectLifecycleSource;
  /** Deletes every row of the Project in this service's own database. */
  removeProjectData(projectId: string): Promise<void>;
  logger: StructuredLogger;
  readCurrentTime: () => Date;
}

export type DeletedProjectRemovalOutcome =
  | { status: "skipped" }
  | { status: "ran"; removedProjectIds: string[] };

/**
 * The data lifecycle of a service that keeps no telemetry, such as Prompt: on the replica that holds
 * the lease, it removes the data of each deleted Project that Identity lists and reports it back.
 */
export function createDeletedProjectRemoval(
  options: DeletedProjectRemovalOptions,
): () => Promise<DeletedProjectRemovalOutcome> {
  return async () => {
    if (!await options.tryAcquireLease(options.readCurrentTime())) return { status: "skipped" };
    const { projectsToRemove } = await options.projectLifecycle.readProjectLifecycle();
    const removedProjectIds: string[] = [];
    for (const { projectId } of projectsToRemove) {
      await options.removeProjectData(projectId);
      await options.projectLifecycle.recordDataRemoval(projectId);
      removedProjectIds.push(projectId);
    }
    if (removedProjectIds.length > 0) {
      options.logger.info("Removed deleted Projects' data", { removedProjectIds });
    }
    return { status: "ran", removedProjectIds };
  };
}
