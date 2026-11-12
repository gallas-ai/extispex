import {
  completeOidcSignInRoute,
  displayNameSchema,
  emailSchema,
  OIDC_ATTEMPT_COOKIE_NAME,
  OIDC_SIGN_IN_PATH,
  type OidcSignInFailure,
  SIGN_IN_FAILURE_PARAMETER,
  startOidcSignInRoute,
} from "@extispex/contracts";
import type { StructuredLogger } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { IdentityEnvironment } from "../access/mod.ts";
import { generateRandomCharacters, hashRandomSecret } from "../api-keys/mod.ts";
import type { OidcClaims, OidcProvider } from "./oidc-provider.ts";
import type { OidcRepository, OidcUserIdentity } from "../storage/mod.ts";
import { type BrowserSignIns, isHttpsRequest } from "../sign-in/mod.ts";

/** Long enough to type a password and pass multi-factor authentication at the provider. */
const ATTEMPT_LIFETIME_SECONDS = 10 * 60;

export interface OidcSignInRouteDependencies {
  /** Null when the Instance has no identity provider configured. */
  provider: OidcProvider | null;
  oidcRepository: OidcRepository;
  browserSignIns: BrowserSignIns;
  logger: StructuredLogger;
  readCurrentTime: () => Date;
}

/**
 * The authorization code flow with PKCE. Identity is the confidential client, so tokens from the
 * provider never reach the browser; afterwards the browser holds the same sign-in cookie as with a
 * password. Every outcome is a redirect, because the browser arrives by navigating here.
 */
export function registerOidcSignInRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: OidcSignInRouteDependencies,
): void {
  const { provider, oidcRepository, browserSignIns, logger, readCurrentTime } = dependencies;

  app.openapi(startOidcSignInRoute, async (context) => {
    if (provider === null) return redirectAfterFailure(context, "oidc_disabled");
    const { returnTo } = context.req.valid("query");
    let authorizationRequest;
    try {
      authorizationRequest = await provider.createAuthorizationRequest();
    } catch (error) {
      logger.error("The identity provider could not be read", { error });
      return redirectAfterFailure(context, "provider_unavailable");
    }
    const browserBinding = generateRandomCharacters();
    const now = readCurrentTime();
    await oidcRepository.createAttempt({
      stateHash: await hashRandomSecret(authorizationRequest.state),
      browserBindingHash: await hashRandomSecret(browserBinding),
      nonce: authorizationRequest.nonce,
      codeVerifier: authorizationRequest.codeVerifier,
      returnTo: readSafeReturnPath(returnTo),
      expiresAt: new Date(now.getTime() + ATTEMPT_LIFETIME_SECONDS * 1000),
    }, now);
    setCookie(context, OIDC_ATTEMPT_COOKIE_NAME, browserBinding, {
      path: OIDC_SIGN_IN_PATH,
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttpsRequest(context),
      maxAge: ATTEMPT_LIFETIME_SECONDS,
    });
    return context.redirect(authorizationRequest.authorizationUrl.href, 302);
  });

  app.openapi(completeOidcSignInRoute, async (context) => {
    if (provider === null) return redirectAfterFailure(context, "oidc_disabled");
    const responseUrl = new URL(context.req.url);
    const browserBinding = getCookie(context, OIDC_ATTEMPT_COOKIE_NAME);
    deleteCookie(context, OIDC_ATTEMPT_COOKIE_NAME, {
      path: OIDC_SIGN_IN_PATH,
      secure: isHttpsRequest(context),
    });
    const state = responseUrl.searchParams.get("state");
    const attempt = state === null
      ? null
      : await oidcRepository.consumeAttempt(await hashRandomSecret(state));
    if (
      attempt === null || browserBinding === undefined ||
      attempt.browserBindingHash !== await hashRandomSecret(browserBinding) ||
      attempt.expiresAt <= readCurrentTime()
    ) {
      return redirectAfterFailure(context, "attempt_expired");
    }

    let claims;
    try {
      claims = await provider.completeAuthorization(responseUrl.search, {
        state: state!,
        nonce: attempt.nonce,
        codeVerifier: attempt.codeVerifier,
      });
    } catch (error) {
      logger.warn("The identity provider refused a sign-in", { error });
      return redirectAfterFailure(context, "provider_refused");
    }

    const identity = toUserIdentity(claims);
    if (identity === null) {
      logger.warn("An ID token has no usable, verified email address", { sub: claims.subject });
      return redirectAfterFailure(context, "email_missing");
    }
    const signIn = await oidcRepository.signInUser(identity, readCurrentTime());
    if (signIn.status === "email_taken") return redirectAfterFailure(context, "email_taken");
    if (signIn.status === "deactivated") return redirectAfterFailure(context, "user_deactivated");
    await browserSignIns.start(context, signIn.user.id);
    return context.redirect(attempt.returnTo, 302);
  });
}

function redirectAfterFailure(context: Context, failure: OidcSignInFailure) {
  return context.redirect(`/?${SIGN_IN_FAILURE_PARAMETER}=${failure}`, 302);
}

/**
 * The email and name to store, or null when the token has no email that can be used. The address
 * is the user's identity in the UI, so one the provider says it has not verified is refused.
 */
function toUserIdentity(claims: OidcClaims): OidcUserIdentity | null {
  const email = emailSchema.safeParse(claims.email);
  if (!email.success || claims.isEmailUnverified) return null;
  const displayName = displayNameSchema.safeParse(claims.name?.slice(0, 100));
  return {
    issuer: claims.issuer,
    subject: claims.subject,
    email: email.data,
    displayName: displayName.success ? displayName.data : email.data.split("@")[0].slice(0, 100),
    companyGroups: claims.companyGroups,
  };
}

/**
 * Keeps the return address inside this Instance. `//other.example` and `/\other.example` are
 * addresses on another host to a browser, so anything like them goes to the start page.
 */
function readSafeReturnPath(returnTo: string | undefined): string {
  if (returnTo === undefined || !/^\/(?![/\\])/.test(returnTo) || /[\r\n\t]/.test(returnTo)) {
    return "/";
  }
  return returnTo;
}
