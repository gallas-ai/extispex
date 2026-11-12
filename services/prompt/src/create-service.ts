import type { ServiceRequestHandler } from "@extispex/service-client";
import {
  createDeletedProjectRemoval,
  createServiceHttpApp,
  DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS,
  type DeletedProjectRemovalOutcome,
  type ProjectLifecycleSource,
  type RequestAuthenticator,
  type StructuredLogger,
} from "@extispex/service-runtime";
import { createBackgroundLease } from "@extispex/service-storage";
import { type PromptServiceEnvironment, registerPromptRoutes } from "./prompts/mod.ts";
import { createPromptRepository, type PromptDatabase } from "./storage/mod.ts";

export { migratePromptDatabase, openPromptDatabase, type PromptDatabase } from "./storage/mod.ts";

export interface PromptServiceDependencies {
  database: PromptDatabase;
  requestAuthenticator: RequestAuthenticator;
  /** Identity's deleted Projects, asked with this service's token. */
  projectLifecycle: ProjectLifecycleSource;
  logger: StructuredLogger;
  readCurrentTime?: () => Date;
  /** How often `runDataLifecycle` runs; its lease lasts two intervals. */
  dataLifecycleIntervalMilliseconds?: number;
  /** Who holds the data lifecycle's lease; one ID per process by default. */
  leaseHolder?: string;
}

export interface PromptService {
  /** Handles the prompt REST API, the OpenAPI document and health checks. */
  handleRequest: ServiceRequestHandler;
  /**
   * One run of the periodic data work, if this replica gets the lease: removes deleted Projects'
   * prompts. `main.ts` runs it every `DATA_LIFECYCLE_INTERVAL_MILLISECONDS`.
   */
  runDataLifecycle(): Promise<DeletedProjectRemovalOutcome>;
}

export function createPromptService(dependencies: PromptServiceDependencies): PromptService {
  const app = createServiceHttpApp<PromptServiceEnvironment>({
    apiTitle: "Extispex: Prompt API",
    logger: dependencies.logger,
  });
  const readCurrentTime = dependencies.readCurrentTime ?? (() => new Date());
  const promptRepository = createPromptRepository(dependencies.database);
  registerPromptRoutes(app, {
    promptRepository,
    requestAuthenticator: dependencies.requestAuthenticator,
    readCurrentTime,
  });
  const lease = createBackgroundLease(dependencies.database, {
    name: "data-lifecycle",
    holder: dependencies.leaseHolder ?? crypto.randomUUID(),
    durationMilliseconds: 2 *
      (dependencies.dataLifecycleIntervalMilliseconds ??
        DEFAULT_DATA_LIFECYCLE_INTERVAL_MILLISECONDS),
  });
  return {
    handleRequest: (request) => app.fetch(request),
    runDataLifecycle: createDeletedProjectRemoval({
      tryAcquireLease: lease.tryAcquire,
      projectLifecycle: dependencies.projectLifecycle,
      removeProjectData: promptRepository.removeProjectData,
      logger: dependencies.logger,
      readCurrentTime,
    }),
  };
}
