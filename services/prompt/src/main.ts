import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityProjectResolver,
  createStructuredLogger,
  readPortEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import { createPromptService, openPromptDatabase } from "./create-service.ts";

const logger = createStructuredLogger("prompt");

const database = await openPromptDatabase(readRequiredEnvironmentVariable("PROMPT_DATABASE_URL"));
const promptService = createPromptService({
  database,
  projectResolver: createIdentityProjectResolver({
    identityClient: createHttpServiceClient(readRequiredEnvironmentVariable("IDENTITY_URL")),
  }),
  logger,
});

const httpServer = Deno.serve(
  {
    port: readPortEnvironmentVariable("PROMPT_PORT", 8081),
    onListen: ({ port }) => logger.info("HTTP server listening", { port }),
  },
  promptService.handleRequest,
);

runOnTerminationSignal(logger, async () => {
  await httpServer.shutdown();
  await database.close();
});
