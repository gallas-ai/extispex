import type { ServiceRequestHandler } from "@extispex/service-client";
import {
  createServiceHttpApp,
  type RequestAuthenticator,
  type StructuredLogger,
} from "@extispex/service-runtime";
import { type PromptServiceEnvironment, registerPromptRoutes } from "./prompts/prompt-routes.ts";
import type { PromptDatabase } from "./storage/prompt-database.ts";
import { createPromptRepository } from "./storage/prompt-repository.ts";

export { openPromptDatabase, type PromptDatabase } from "./storage/prompt-database.ts";

export interface PromptServiceDependencies {
  database: PromptDatabase;
  requestAuthenticator: RequestAuthenticator;
  logger: StructuredLogger;
  readCurrentTime?: () => Date;
}

export interface PromptService {
  /** Handles the prompt REST API, the OpenAPI document and health checks. */
  handleRequest: ServiceRequestHandler;
}

export function createPromptService(dependencies: PromptServiceDependencies): PromptService {
  const app = createServiceHttpApp<PromptServiceEnvironment>({
    apiTitle: "Extispex: Prompt API",
    logger: dependencies.logger,
  });
  registerPromptRoutes(app, {
    promptRepository: createPromptRepository(dependencies.database),
    requestAuthenticator: dependencies.requestAuthenticator,
    readCurrentTime: dependencies.readCurrentTime ?? (() => new Date()),
  });
  return { handleRequest: (request) => app.fetch(request) };
}
