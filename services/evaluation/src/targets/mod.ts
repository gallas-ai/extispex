/** Public entry point of the targets module: the only file other modules import. */
export { parseDestinationAllowlist } from "./destination-allowlist.ts";
export {
  createTargetClient,
  DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  type ResolveHostAddresses,
  type TargetClient,
  type TargetEndpoint,
} from "./target-client.ts";
export { registerTargetRoutes } from "./target-routes.ts";
