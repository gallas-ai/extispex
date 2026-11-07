import type { RouteConfig } from "@hono/zod-openapi";
import { promptPublicRoutes } from "./prompt/prompt-routes.ts";
import { telemetryPublicRoutes } from "./telemetry/trace-routes.ts";

export type PublicApiServiceName = "telemetry" | "prompt";

/**
 * Every endpoint of the public REST API, by the service that implements it. The services attach
 * handlers to these definitions, and the Gateway builds its forwarding table and the combined
 * OpenAPI document from the same list, so the three cannot drift apart.
 */
export const publicApiRoutesByService: Record<PublicApiServiceName, RouteConfig[]> = {
  telemetry: telemetryPublicRoutes,
  prompt: promptPublicRoutes,
};

export const PUBLIC_API_INFO = {
  title: "Extispex API",
  version: "1",
  description: "Send the Project API key as `Authorization: Bearer <key>`.",
};
