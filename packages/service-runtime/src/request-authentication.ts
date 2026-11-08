import { createErrorResponse, isRoleAtLeast, type Role } from "@extispex/contracts";
import type { ServiceClient } from "@extispex/service-client";
import type { MiddlewareHandler } from "hono";
import {
  type AccessTokenVerifier,
  createAccessTokenVerifier,
  createIdentityPublicKeySetSource,
} from "./access-tokens.ts";
import {
  createIdentityProjectResolver,
  extractBearerToken,
  type ProjectResolver,
} from "./project-authentication.ts";
import { createIdentityServiceTokenSource, createServiceTokenClient } from "./service-tokens.ts";

/** Which Project a request acts on, and what its caller may do there. */
export interface ProjectAccess {
  projectId: string;
  role: Role;
}

/** Finds out which Project a request with a Project API key or an access token acts on. */
export interface RequestAuthenticator {
  /**
   * Resolves to the Project and Role, or null without working credentials or with an access token
   * that is not scoped to a Project. Rejects with `IdentityUnavailableError` when the credentials
   * cannot be checked.
   */
  authenticateRequest(
    authorizationHeader: string | null | undefined,
  ): Promise<ProjectAccess | null>;
}

/** A Project API key reads and changes the Project's data, but never manages access. */
export const API_KEY_ROLE: Role = "editor";

/** A JWT is three base64url parts; an API key never contains a dot. */
const ACCESS_TOKEN_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export interface RequestAuthenticatorDependencies {
  projectResolver: ProjectResolver;
  accessTokenVerifier: AccessTokenVerifier;
}

export function createRequestAuthenticator(
  dependencies: RequestAuthenticatorDependencies,
): RequestAuthenticator {
  return {
    async authenticateRequest(authorizationHeader) {
      const bearerToken = extractBearerToken(authorizationHeader);
      if (bearerToken === null) return null;
      if (ACCESS_TOKEN_PATTERN.test(bearerToken)) {
        const verifiedToken = await dependencies.accessTokenVerifier.verifyAccessToken(bearerToken);
        if (verifiedToken?.projectId == null || verifiedToken.role === null) return null;
        return { projectId: verifiedToken.projectId, role: verifiedToken.role };
      }
      const projectId = await dependencies.projectResolver.resolveProjectId(bearerToken);
      return projectId === null ? null : { projectId, role: API_KEY_ROLE };
    },
  };
}

export interface IdentityRequestAuthenticatorOptions {
  identityClient: ServiceClient;
  /** This service's client ID in Identity's `SERVICE_CLIENTS`, such as `telemetry`. */
  clientId: string;
  clientSecret: string;
}

/**
 * The authenticator every service uses in production: access tokens are verified locally with
 * Identity's public keys, and API keys are resolved through Identity with this service's token.
 */
export function createIdentityRequestAuthenticator(
  options: IdentityRequestAuthenticatorOptions,
): RequestAuthenticator {
  const serviceTokens = createIdentityServiceTokenSource(options);
  return createRequestAuthenticator({
    projectResolver: createIdentityProjectResolver({
      identityClient: createServiceTokenClient(options.identityClient, serviceTokens),
    }),
    accessTokenVerifier: createAccessTokenVerifier({
      readPublicKeySet: createIdentityPublicKeySetSource(options.identityClient),
    }),
  });
}

/** Hono context variables set by {@link requireProjectAccess}. */
export interface ProjectAccessEnvironment {
  Variables: { projectAccess: ProjectAccess };
}

/** The Role a request needs: `viewer` to read, `editor` for anything that changes data. */
export function findRequiredRole(method: string): Role {
  return method === "GET" || method === "HEAD" ? "viewer" : "editor";
}

/**
 * Hono middleware that authenticates the request, requires the Role its method needs and sets
 * `projectAccess`. Without working credentials it answers 401, with too low a Role 403.
 */
export function requireProjectAccess(
  requestAuthenticator: RequestAuthenticator,
): MiddlewareHandler<ProjectAccessEnvironment> {
  return async (context, next) => {
    const projectAccess = await requestAuthenticator.authenticateRequest(
      context.req.header("authorization"),
    );
    if (projectAccess === null) {
      return context.json(
        createErrorResponse(
          "unauthenticated",
          "A valid API key, or an access token for a Project, is required in the Authorization " +
            "header as a Bearer token.",
        ),
        401,
      );
    }
    const requiredRole = findRequiredRole(context.req.method);
    if (!isRoleAtLeast(projectAccess.role, requiredRole)) {
      return context.json(
        createErrorResponse(
          "forbidden",
          `This takes the Role ${requiredRole} in the Project; the caller has ${projectAccess.role}.`,
        ),
        403,
      );
    }
    context.set("projectAccess", projectAccess);
    await next();
  };
}
