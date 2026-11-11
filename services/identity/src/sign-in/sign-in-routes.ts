import {
  changeOwnPasswordRoute,
  createErrorResponse,
  getSignInOptionsRoute,
  issueUserAccessTokenRoute,
  SIGN_IN_COOKIE_NAME,
  signInRoute,
  signOutRoute,
  USER_SUBJECT_PREFIX,
} from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createDecoyPasswordHash, hashPassword, verifyPassword } from "../accounts/mod.ts";
import type { AccessTokenSigner } from "../access-tokens/mod.ts";
import type { IdentityEnvironment } from "../access/mod.ts";
import { hashRandomSecret } from "../api-keys/mod.ts";
import type {
  AccessRepository,
  ProjectRepository,
  SignInRepository,
  StoredUser,
} from "../storage/mod.ts";
import { type BrowserSignIns, SIGN_IN_IDLE_SECONDS } from "./browser-sign-ins.ts";
import type { PasswordAttemptThrottle } from "./password-attempt-throttle.ts";

export interface SignInRouteDependencies {
  accessRepository: AccessRepository;
  projectRepository: ProjectRepository;
  signInRepository: SignInRepository;
  accessTokenSigner: AccessTokenSigner;
  browserSignIns: BrowserSignIns;
  passwordAttemptThrottle: PasswordAttemptThrottle;
  areLocalAccountsEnabled: boolean;
  /** The name of the company's identity provider, or null without OIDC. */
  oidcProviderName: string | null;
  passwordHashIterations: number;
  readCurrentTime: () => Date;
}

const signedOutError = createErrorResponse(
  "unauthenticated",
  "The browser is not signed in, or the sign-in has expired. Sign in again.",
);

const localAccountsDisabledError = createErrorResponse(
  "local_accounts_disabled",
  "Local accounts are disabled on this Instance. Set LOCAL_ACCOUNTS=enabled to use them.",
);

function tooManyAttemptsError(retryAfterSeconds: number) {
  return createErrorResponse(
    "too_many_attempts",
    `Too many wrong passwords. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
  );
}

/** The browser's address that the Gateway set, or null for a request that did not pass it. */
function readClientAddress(context: Context): string | null {
  return context.req.header("x-forwarded-for")?.trim() || null;
}

/**
 * Sign-in with a local account, sign-out, and access tokens for the signed-in browser. The
 * browser holds only an HttpOnly cookie with a random value, which scripts cannot read; the UI
 * keeps access tokens in memory and asks for a new one every few minutes.
 */
export function registerSignInRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: SignInRouteDependencies,
): void {
  const { accessRepository, signInRepository, browserSignIns, passwordAttemptThrottle } =
    dependencies;
  let decoyPasswordHash: Promise<string> | null = null;

  const checkPassword = async (user: StoredUser | null, password: string) => {
    if (user === null || user.passwordHash === null || user.deactivatedAt !== null) {
      decoyPasswordHash ??= createDecoyPasswordHash(dependencies.passwordHashIterations);
      await verifyPassword(password, await decoyPasswordHash);
      return false;
    }
    return await verifyPassword(password, user.passwordHash);
  };

  const findSignIn = async (context: Context) => {
    const cookieValue = getCookie(context, SIGN_IN_COOKIE_NAME);
    const signIn = cookieValue === undefined ? null : await signInRepository.findActiveSignIn(
      await hashRandomSecret(cookieValue),
      dependencies.readCurrentTime(),
    );
    return signIn === null ? null : { ...signIn, cookieValue: cookieValue! };
  };

  app.openapi(getSignInOptionsRoute, (context) => {
    return context.json({
      areLocalAccountsEnabled: dependencies.areLocalAccountsEnabled,
      oidcProviderName: dependencies.oidcProviderName,
    }, 200);
  });

  app.openapi(signInRoute, async (context) => {
    if (!dependencies.areLocalAccountsEnabled) {
      return context.json(localAccountsDisabledError, 403);
    }
    const { email, password } = context.req.valid("json");
    const attempt = await passwordAttemptThrottle.beginAttempt(email, readClientAddress(context));
    if (attempt.status === "blocked") {
      context.header("retry-after", String(attempt.retryAfterSeconds));
      return context.json(tooManyAttemptsError(attempt.retryAfterSeconds), 429);
    }
    const user = await accessRepository.findUserByEmail(email);
    if (!await checkPassword(user, password)) {
      return context.json(
        createErrorResponse("invalid_credentials", "The email address or password is wrong."),
        401,
      );
    }
    await attempt.markSucceeded();
    await browserSignIns.start(context, user!.id);
    const { passwordHash: _passwordHash, ...signedInUser } = user!;
    return context.json(signedInUser, 200);
  });

  app.openapi(changeOwnPasswordRoute, async (context) => {
    if (!dependencies.areLocalAccountsEnabled) {
      return context.json(localAccountsDisabledError, 403);
    }
    const signIn = await findSignIn(context);
    const user = signIn === null ? null : await accessRepository.findUser(signIn.userId);
    if (signIn === null || user === null) {
      browserSignIns.clearCookie(context);
      return context.json(signedOutError, 401);
    }
    if (user.passwordHash === null) {
      return context.json(
        createErrorResponse(
          "not_a_local_account",
          "This user signs in through the company's identity provider and has no password here.",
        ),
        403,
      );
    }
    const { currentPassword, newPassword } = context.req.valid("json");
    const attempt = await passwordAttemptThrottle.beginAttempt(
      user.email,
      readClientAddress(context),
    );
    if (attempt.status === "blocked") {
      context.header("retry-after", String(attempt.retryAfterSeconds));
      return context.json(tooManyAttemptsError(attempt.retryAfterSeconds), 429);
    }
    if (!await verifyPassword(currentPassword, user.passwordHash)) {
      return context.json(
        createErrorResponse("invalid_credentials", "The current password is wrong."),
        403,
      );
    }
    await attempt.markSucceeded();
    await signInRepository.changePassword(
      user.id,
      await hashPassword(newPassword, dependencies.passwordHashIterations),
      signIn.id,
    );
    return context.body(null, 204);
  });

  app.openapi(signOutRoute, async (context) => {
    const cookieValue = getCookie(context, SIGN_IN_COOKIE_NAME);
    if (cookieValue !== undefined) {
      await signInRepository.deleteSignIn(await hashRandomSecret(cookieValue));
    }
    browserSignIns.clearCookie(context);
    return context.body(null, 204);
  });

  app.openapi(issueUserAccessTokenRoute, async (context) => {
    const { projectId } = context.req.valid("json");
    const now = dependencies.readCurrentTime();
    const signIn = await findSignIn(context);
    if (signIn === null) {
      browserSignIns.clearCookie(context);
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
    browserSignIns.refreshCookie(context, signIn.cookieValue);
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
