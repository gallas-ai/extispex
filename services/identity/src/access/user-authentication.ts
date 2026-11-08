import {
  createErrorResponse,
  SERVICE_SUBJECT_PREFIX,
  SIGN_IN_COOKIE_PATH,
  USER_SUBJECT_PREFIX,
} from "@extispex/contracts";
import { extractBearerToken } from "@extispex/service-runtime";
import type { MiddlewareHandler } from "hono";
import type { AccessTokenSigner } from "../access-tokens/signing-keys.ts";
import type { AccessRepository, StoredUser } from "../storage/access-repository.ts";

/** Hono context variables of Identity's routes. */
export interface IdentityEnvironment {
  Variables: { currentUser: StoredUser };
}

const unauthenticatedUserError = createErrorResponse(
  "unauthenticated",
  "A user's valid access token is required in the Authorization header as a Bearer token.",
);

/**
 * Requires a user's access token on every `/v1/` path except sign-in, and sets `currentUser`.
 * Identity reads the user's Instance admin status and Roles from its database rather than from the
 * token, so a change applies to Identity's own endpoints at once.
 */
export function requireSignedInUser(
  accessTokenSigner: AccessTokenSigner,
  accessRepository: AccessRepository,
): MiddlewareHandler<IdentityEnvironment> {
  return async (context, next) => {
    if (
      context.req.path === SIGN_IN_COOKIE_PATH ||
      context.req.path.startsWith(`${SIGN_IN_COOKIE_PATH}/`)
    ) {
      return await next();
    }
    const accessToken = extractBearerToken(context.req.header("authorization"));
    const verifiedToken = accessToken === null
      ? null
      : await accessTokenSigner.accessTokenVerifier.verifyAccessToken(accessToken);
    if (verifiedToken === null || !verifiedToken.subject.startsWith(USER_SUBJECT_PREFIX)) {
      return context.json(unauthenticatedUserError, 401);
    }
    const user = await accessRepository.findUser(
      verifiedToken.subject.slice(USER_SUBJECT_PREFIX.length),
    );
    if (user === null || user.deactivatedAt !== null) {
      return context.json(unauthenticatedUserError, 401);
    }
    context.set("currentUser", user);
    await next();
  };
}

/** The client ID of a valid service token in the Authorization header, or null. */
export async function authenticateService(
  accessTokenSigner: AccessTokenSigner,
  authorizationHeader: string | undefined,
): Promise<string | null> {
  const accessToken = extractBearerToken(authorizationHeader);
  if (accessToken === null) return null;
  const verifiedToken = await accessTokenSigner.accessTokenVerifier.verifyAccessToken(accessToken);
  if (verifiedToken === null || !verifiedToken.subject.startsWith(SERVICE_SUBJECT_PREFIX)) {
    return null;
  }
  return verifiedToken.subject.slice(SERVICE_SUBJECT_PREFIX.length);
}

export const forbiddenError = (message: string) => createErrorResponse("forbidden", message);

export const INSTANCE_ADMIN_REQUIRED = forbiddenError("This takes an Instance admin.");

export const PROJECT_ADMIN_REQUIRED = forbiddenError(
  "This takes the Role admin in the Project, or an Instance admin.",
);

/** Whether the user may manage the Project's Role assignments and API keys. */
export async function canManageProject(
  accessRepository: AccessRepository,
  user: StoredUser,
  projectId: string,
): Promise<boolean> {
  return user.isInstanceAdmin ||
    await accessRepository.findUserRole(user.id, projectId) === "admin";
}
