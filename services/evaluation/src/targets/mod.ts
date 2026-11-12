/** Public entry point of the targets module: the only file other modules import. */
export {
  DestinationNotAllowedError,
  postToAllowedDestination,
  resolveAllowedAddresses,
  resolveWithSystem,
} from "./allowed-destination-post.ts";
export { type DestinationAllowlist, parseDestinationAllowlist } from "./destination-allowlist.ts";
export { parseProxyRouting, type ProxyEnvironment, type ProxyRouting } from "./proxy-settings.ts";
export {
  createTargetClient,
  DEFAULT_TARGET_TIMEOUT_MILLISECONDS,
  type ResolveHostAddresses,
  type TargetClient,
  type TargetEndpoint,
} from "./target-client.ts";
export { registerTargetRoutes } from "./target-routes.ts";
