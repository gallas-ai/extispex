import {
  API_KEY_SECURITY_SCHEME,
  API_KEY_SECURITY_SCHEME_NAME,
  createErrorResponse,
} from "@extispex/contracts";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";
import type { StructuredLogger } from "./structured-logger.ts";

export interface ServiceHttpAppOptions {
  /** Shown as the title of the service's own `/openapi.json`. */
  apiTitle: string;
  logger: StructuredLogger;
}

/**
 * The HTTP app every service starts from: `/health`, `/openapi.json` with the routes registered
 * later, and the shared error format for invalid requests, unknown paths and unexpected errors.
 */
export function createServiceHttpApp<Environment extends Env = Env>(
  options: ServiceHttpAppOptions,
): OpenAPIHono<Environment> {
  const app = new OpenAPIHono<Environment>({
    defaultHook: (validationResult, context) => {
      if (!validationResult.success) {
        const issueDescriptions = validationResult.error.issues.map((issue) =>
          `${issue.path.join(".") || "request"}: ${issue.message}`
        );
        return context.json(
          createErrorResponse("invalid_request", issueDescriptions.join("; ")),
          400,
        );
      }
    },
  });
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.openAPIRegistry.registerComponent(
    "securitySchemes",
    API_KEY_SECURITY_SCHEME_NAME,
    API_KEY_SECURITY_SCHEME,
  );
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: options.apiTitle, version: "1" },
  });
  app.notFound((context) =>
    context.json(createErrorResponse("not_found", "No such endpoint."), 404)
  );
  app.onError((error, context) => {
    options.logger.error("Unhandled request error", { error, path: context.req.path });
    return context.json(
      createErrorResponse("internal_error", "An unexpected error occurred."),
      500,
    );
  });
  return app;
}
