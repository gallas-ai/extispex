import type { RouteConfig } from "@hono/zod-openapi";
import { evaluationPublicRoutes } from "./evaluation/evaluation-routes.ts";
import { identityPublicRoutes } from "./identity/project-routes.ts";
import { promptPublicRoutes } from "./prompt/prompt-routes.ts";
import { telemetryPublicRoutes } from "./telemetry/trace-routes.ts";

export type PublicApiServiceName = "telemetry" | "prompt" | "identity" | "evaluation";

/**
 * Every endpoint of the public REST API, by the service that implements it. The services attach
 * handlers to these definitions, and the Gateway builds its forwarding table and the combined
 * OpenAPI document from the same list, so the three cannot drift apart.
 */
export const publicApiRoutesByService: Record<PublicApiServiceName, RouteConfig[]> = {
  telemetry: telemetryPublicRoutes,
  prompt: promptPublicRoutes,
  identity: identityPublicRoutes,
  evaluation: evaluationPublicRoutes,
};

export const PUBLIC_API_INFO = {
  title: "Extispex API",
  version: "1",
  description: "Send a Project API key or an access token as `Authorization: Bearer <value>`. " +
    "A browser signs in at `/v1/sign-in` or through `/v1/sign-in/oidc/authorize` and then gets " +
    "short-lived access tokens from " +
    "`/v1/sign-in/access-tokens`. Managing users, Groups, Roles, Projects and API keys takes a " +
    "user's access token.",
};
