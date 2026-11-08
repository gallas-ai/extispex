/**
 * Identity could not be asked, so the request's credentials are neither accepted nor refused.
 * Services answer `503` with `Retry-After`, or gRPC `UNAVAILABLE`, which clients retry.
 */
export class IdentityUnavailableError extends Error {
  override name = "IdentityUnavailableError";
}
