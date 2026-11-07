import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { describeErrorResponse } from "../openapi-route-parts.ts";

/** Longer bearer tokens are refused without asking Identity, so they never reach a lookup. */
export const MAXIMUM_API_KEY_LENGTH = 256;

export const resolveApiKeyRequestSchema = z.object({
  apiKey: z.string().min(1).max(MAXIMUM_API_KEY_LENGTH),
});

export const resolvedApiKeySchema = z.object({ projectId: z.string() });

/**
 * Finds the Project an API key belongs to, for Telemetry and Prompt. It is internal: the Gateway
 * does not forward it, because it is not in `publicApiRoutesByService`. The key travels in the body
 * so that it never appears in a URL or an access log.
 */
export const resolveApiKeyRoute = createRoute({
  method: "post",
  path: "/internal/v1/api-keys/resolve",
  summary: "Find the Project of a working API key.",
  tags: ["Internal"],
  request: {
    body: { content: { "application/json": { schema: resolveApiKeyRequestSchema } } },
  },
  responses: {
    200: {
      description: "The key works and belongs to this Project.",
      content: { "application/json": { schema: resolvedApiKeySchema } },
    },
    400: describeErrorResponse("The request is invalid."),
    404: describeErrorResponse("The key is unknown or revoked, or its Project is deleted."),
  },
});

export type ResolveApiKeyRequest = z.infer<typeof resolveApiKeyRequestSchema>;
export type ResolvedApiKey = z.infer<typeof resolvedApiKeySchema>;
