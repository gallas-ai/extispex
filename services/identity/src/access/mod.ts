/** Public entry point of the access module: the only file other modules import. */
export { registerAccessRoutes } from "./access-routes.ts";
export {
  authenticateService,
  canManageProject,
  type IdentityEnvironment,
  INSTANCE_ADMIN_REQUIRED,
  PROJECT_ADMIN_REQUIRED,
  requireSignedInUser,
} from "./user-authentication.ts";
