import { DEACTIVATED_USER_RETENTION_DAYS } from "@extispex/contracts";
import type { StructuredLogger } from "@extispex/service-runtime";
import type { BackgroundLease } from "@extispex/service-storage";
import { ACCESS_TOKEN_LIFETIME_SECONDS } from "../access-tokens/signing-keys.ts";
import type { AccessRepository } from "../storage/access-repository.ts";
import type { ProjectRepository } from "../storage/project-repository.ts";

const MILLISECONDS_PER_DAY = 86_400_000;
/** Identity's own name among the services that remove a deleted Project's data. */
const IDENTITY_SERVICE_NAME = "identity";

export interface IdentityDataLifecycleDependencies {
  projectRepository: ProjectRepository;
  accessRepository: AccessRepository;
  lease: BackgroundLease;
  logger: StructuredLogger;
  readCurrentTime: () => Date;
}

/** What one run did, or that another replica holds the lease. */
export type IdentityDataLifecycleOutcome =
  | { status: "skipped" }
  | { status: "ran"; removedProjectIds: string[]; deletedUserCount: number };

/**
 * Identity's periodic data work: it removes its own data of deleted Projects, API keys and Role
 * assignments, and deletes the personal data of users deactivated more than 30 days ago.
 */
export function createIdentityDataLifecycle(
  dependencies: IdentityDataLifecycleDependencies,
): () => Promise<IdentityDataLifecycleOutcome> {
  const { projectRepository, accessRepository, logger, readCurrentTime } = dependencies;
  return async () => {
    if (!await dependencies.lease.tryAcquire(readCurrentTime())) return { status: "skipped" };
    const { projectsToRemove } = await projectRepository.readProjectLifecycle(
      IDENTITY_SERVICE_NAME,
      ACCESS_TOKEN_LIFETIME_SECONDS * 1000,
    );
    for (const { projectId } of projectsToRemove) {
      await projectRepository.removeOwnProjectData(projectId);
      await projectRepository.recordDataRemoval(
        projectId,
        IDENTITY_SERVICE_NAME,
        readCurrentTime(),
      );
    }
    const now = readCurrentTime();
    const deletedUserCount = await accessRepository.deletePersonalDataOfUsersDeactivatedBefore(
      new Date(now.getTime() - DEACTIVATED_USER_RETENTION_DAYS * MILLISECONDS_PER_DAY),
      now,
    );
    if (projectsToRemove.length > 0 || deletedUserCount > 0) {
      logger.info("Removed data", {
        removedProjectIds: projectsToRemove.map(({ projectId }) => projectId),
        deletedUserCount,
      });
    }
    return {
      status: "ran",
      removedProjectIds: projectsToRemove.map(({ projectId }) => projectId),
      deletedUserCount,
    };
  };
}
