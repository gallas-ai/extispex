import { createErrorResponse, PUBLIC_API_SECURITY_SCHEMES } from "@extispex/contracts";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";
import { ProjectResolutionUnavailableError } from "./project-authentication.ts";
import type { StructuredLogger } from "./structured-logger.ts";

/** Seconds a client should wait before retrying a request that failed for a passing reason. */
export const RETRY_AFTER_SECONDS = "5";

export interface ServiceHttpAppOptions {
  /** Shown as the title of the service's own `/openapi.json`. */
  apiTitle: string;
  logger: StructuredLogger;
}

/**
 * The HTTP app every service starts from: `/health`, `/openapi.json` with the routes registered
 * later, and the shared error format for invalid requests, unknown paths and unexpected errors.
 * A request whose API key cannot be checked because Identity is unavailable gets 503, which
 * clients may retry.
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
  for (const [schemeName, securityScheme] of Object.entries(PUBLIC_API_SECURITY_SCHEMES)) {
    app.openAPIRegistry.registerComponent("securitySchemes", schemeName, securityScheme);
  }
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: options.apiTitle, version: "1" },
  });
  app.notFound((context) =>
    context.json(createErrorResponse("not_found", "No such endpoint."), 404)
  );
  app.onError((error, context) => {
    if (error instanceof ProjectResolutionUnavailableError) {
      options.logger.warn("API key could not be checked", { error, path: context.req.path });
      context.header("retry-after", RETRY_AFTER_SECONDS);
      return context.json(
        createErrorResponse(
          "identity_unavailable",
          "The API key could not be checked. Retry later.",
        ),
        503,
      );
    }
    options.logger.error("Unhandled request error", { error, path: context.req.path });
    return context.json(
      createErrorResponse("internal_error", "An unexpected error occurred."),
      500,
    );
  });
  return app;
}
