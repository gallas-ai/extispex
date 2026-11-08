import { createHttpServiceClient } from "@extispex/service-client";
import {
  createIdentityRequestAuthenticator,
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
  requestAuthenticator: createIdentityRequestAuthenticator({
    identityClient: createHttpServiceClient(readRequiredEnvironmentVariable("IDENTITY_URL")),
    clientId: "prompt",
    clientSecret: readRequiredEnvironmentVariable("IDENTITY_CLIENT_SECRET"),
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
