/** Public entry point of the projects module: the only file other modules import. */
export { createFirstProjectIfNone, FIRST_PROJECT_NAME } from "./first-project.ts";
export { registerProjectLifecycleRoutes } from "./project-lifecycle-routes.ts";
export { registerProjectRoutes } from "./project-routes.ts";
