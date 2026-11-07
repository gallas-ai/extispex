import { createHttpServiceClient } from "@extispex/service-client";
import {
  createStructuredLogger,
  readOptionalEnvironmentVariable,
  readPortEnvironmentVariable,
  readRequiredEnvironmentVariable,
  runOnTerminationSignal,
} from "@extispex/service-runtime";
import { createGatewayService } from "./create-service.ts";

const logger = createStructuredLogger("gateway");

const gatewayService = createGatewayService({
  telemetryClient: createHttpServiceClient(readRequiredEnvironmentVariable("TELEMETRY_URL")),
  webAssetsDirectory: readOptionalEnvironmentVariable("WEB_ASSETS_DIRECTORY") ?? null,
  logger,
});

const httpServer = Deno.serve(
  {
    port: readPortEnvironmentVariable("GATEWAY_PORT", 8080),
    onListen: ({ port }) => logger.info("HTTP server listening", { port }),
  },
  gatewayService.handleRequest,
);

runOnTerminationSignal(logger, () => httpServer.shutdown());
