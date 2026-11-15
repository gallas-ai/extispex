/** Public entry point of the access-tokens module: the only file other modules import. */
export { registerInternalTokenRoutes } from "./internal-token-routes.ts";
export { registerSigningKeyRoutes } from "./signing-key-routes.ts";
export {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  type AccessTokenSigner,
  createAccessTokenSigner,
  createSigningKeyCipher,
  DEFAULT_SIGNING_KEY_PUBLICATION_SECONDS,
  protectStoredSigningKeys,
  resealSigningKeys,
} from "./signing-keys.ts";
