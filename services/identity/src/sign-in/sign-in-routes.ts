import {
  createErrorResponse,
  issueUserAccessTokenRoute,
  SIGN_IN_COOKIE_NAME,
  SIGN_IN_COOKIE_PATH,
  signInRoute,
  signOutRoute,
  USER_SUBJECT_PREFIX,
} from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createDecoyPasswordHash, verifyPassword } from "../accounts/password-hashing.ts";
import type { AccessTokenSigner } from "../access-tokens/signing-keys.ts";
import type { IdentityEnvironment } from "../access/user-authentication.ts";
import { generateRandomCharacters, hashRandomSecret } from "../api-keys/api-key-secrets.ts";
import type { AccessRepository, StoredUser } from "../storage/access-repository.ts";
import type { ProjectRepository } from "../storage/project-repository.ts";
import type { SignInRepository } from "../storage/sign-in-repository.ts";

/** A sign-in ends after this long without a new access token, which a working UI gets every few minutes. */
export const SIGN_IN_IDLE_SECONDS = 12 * 60 * 60;

export interface SignInRouteDependencies {
  accessRepository: AccessRepository;
  projectRepository: ProjectRepository;
  signInRepository: SignInRepository;
  accessTokenSigner: AccessTokenSigner;
  areLocalAccountsEnabled: boolean;
  passwordHashIterations: number;
  readCurrentTime: () => Date;
}

const signedOutError = createErrorResponse(
  "unauthenticated",
  "The browser is not signed in, or the sign-in has expired. Sign in again.",
);

/**
 * Sign-in with a local account, sign-out, and access tokens for the signed-in browser. The
 * browser holds only an HttpOnly cookie with a random value, which scripts cannot read; the UI
 * keeps access tokens in memory and asks for a new one every few minutes.
 */
export function registerSignInRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: SignInRouteDependencies,
): void {
  const { accessRepository, signInRepository } = dependencies;
  let decoyPasswordHash: Promise<string> | null = null;

  const setSignInCookie = (context: Context, cookieValue: string) => {
    setCookie(context, SIGN_IN_COOKIE_NAME, cookieValue, {
      path: SIGN_IN_COOKIE_PATH,
      httpOnly: true,
      sameSite: "Strict",
      secure: isHttpsRequest(context),
      maxAge: SIGN_IN_IDLE_SECONDS,
    });
  };

  const clearSignInCookie = (context: Context) => {
    deleteCookie(context, SIGN_IN_COOKIE_NAME, {
      path: SIGN_IN_COOKIE_PATH,
      secure: isHttpsRequest(context),
    });
  };

  const checkPassword = async (user: StoredUser | null, password: string) => {
    if (user === null || user.passwordHash === null || user.deactivatedAt !== null) {
      decoyPasswordHash ??= createDecoyPasswordHash(dependencies.passwordHashIterations);
      await verifyPassword(password, await decoyPasswordHash);
      return false;
    }
    return await verifyPassword(password, user.passwordHash);
  };

  app.openapi(signInRoute, async (context) => {
    if (!dependencies.areLocalAccountsEnabled) {
      return context.json(
        createErrorResponse(
          "local_accounts_disabled",
          "Local accounts are disabled on this Instance. Set LOCAL_ACCOUNTS=enabled to use them.",
        ),
        403,
      );
    }
    const { email, password } = context.req.valid("json");
    const user = await accessRepository.findUserByEmail(email);
    if (!await checkPassword(user, password)) {
      return context.json(
        createErrorResponse("invalid_credentials", "The email address or password is wrong."),
        401,
      );
    }
    const now = dependencies.readCurrentTime();
    await signInRepository.deleteExpiredSignIns(now);
    const cookieValue = generateRandomCharacters();
    await signInRepository.createSignIn(
      user!.id,
      await hashRandomSecret(cookieValue),
      now,
      new Date(now.getTime() + SIGN_IN_IDLE_SECONDS * 1000),
    );
    setSignInCookie(context, cookieValue);
    const { passwordHash: _passwordHash, ...signedInUser } = user!;
    return context.json(signedInUser, 200);
  });

  app.openapi(signOutRoute, async (context) => {
    const cookieValue = getCookie(context, SIGN_IN_COOKIE_NAME);
    if (cookieValue !== undefined) {
      await signInRepository.deleteSignIn(await hashRandomSecret(cookieValue));
    }
    clearSignInCookie(context);
    return context.body(null, 204);
  });

  app.openapi(issueUserAccessTokenRoute, async (context) => {
    const { projectId } = context.req.valid("json");
    const cookieValue = getCookie(context, SIGN_IN_COOKIE_NAME);
    const now = dependencies.readCurrentTime();
    const signIn = cookieValue === undefined
      ? null
      : await signInRepository.findActiveSignIn(await hashRandomSecret(cookieValue), now);
    if (signIn === null) {
      clearSignInCookie(context);
      return context.json(signedOutError, 401);
    }
    let projectAccess = null;
    if (projectId !== undefined) {
      if (await dependencies.projectRepository.findProject(projectId) === null) {
        return context.json(
          createErrorResponse("not_found", `Project ${projectId} was not found.`),
          404,
        );
      }
      const role = await accessRepository.findUserRole(signIn.userId, projectId);
      if (role === null) {
        return context.json(
          createErrorResponse("forbidden", "You have no Role in this Project."),
          403,
        );
      }
      projectAccess = { projectId, role };
    }
    await signInRepository.extendSignIn(
      signIn.id,
      new Date(now.getTime() + SIGN_IN_IDLE_SECONDS * 1000),
    );
    setSignInCookie(context, cookieValue!);
    const { accessToken, expiresAt } = await dependencies.accessTokenSigner.issueAccessToken(
      `${USER_SUBJECT_PREFIX}${signIn.userId}`,
      projectAccess,
    );
    return context.json({
      accessToken,
      expiresAt: expiresAt.toISOString(),
      projectId: projectAccess?.projectId ?? null,
      role: projectAccess?.role ?? null,
    }, 200);
  });
}

/**
 * Whether the browser reached the Instance over HTTPS, so that the cookie is marked `Secure`. The
 * Gateway passes the original scheme in `X-Forwarded-Proto`.
 */
function isHttpsRequest(context: Context): boolean {
  const forwardedProtocol = context.req.header("x-forwarded-proto")?.split(",")[0].trim();
  return (forwardedProtocol ?? new URL(context.req.url).protocol.replace(":", "")) === "https";
}
