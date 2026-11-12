import { SIGN_IN_COOKIE_NAME, SIGN_IN_COOKIE_PATH } from "@extispex/contracts";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { generateRandomCharacters, hashRandomSecret } from "../api-keys/mod.ts";
import type { SignInRepository } from "../storage/mod.ts";

/** A sign-in ends after this long without a new access token, which a working UI gets every few minutes. */
export const SIGN_IN_IDLE_SECONDS = 12 * 60 * 60;

/** Sign-ins of browsers and the cookie that holds them, however the user proved who they are. */
export interface BrowserSignIns {
  /** Creates a sign-in for the user and sets its cookie on the response. */
  start(context: Context, userId: string): Promise<void>;
  /** Sets the cookie again, so that its lifetime follows the sign-in's. */
  refreshCookie(context: Context, cookieValue: string): void;
  clearCookie(context: Context): void;
}

export function createBrowserSignIns(
  signInRepository: SignInRepository,
  readCurrentTime: () => Date,
): BrowserSignIns {
  const refreshCookie = (context: Context, cookieValue: string) => {
    setCookie(context, SIGN_IN_COOKIE_NAME, cookieValue, {
      path: SIGN_IN_COOKIE_PATH,
      httpOnly: true,
      sameSite: "Strict",
      secure: isHttpsRequest(context),
      maxAge: SIGN_IN_IDLE_SECONDS,
    });
  };

  return {
    async start(context, userId) {
      const now = readCurrentTime();
      await signInRepository.deleteExpiredSignIns(now);
      const cookieValue = generateRandomCharacters();
      await signInRepository.createSignIn(
        userId,
        await hashRandomSecret(cookieValue),
        now,
        new Date(now.getTime() + SIGN_IN_IDLE_SECONDS * 1000),
      );
      refreshCookie(context, cookieValue);
    },
    refreshCookie,
    clearCookie(context) {
      deleteCookie(context, SIGN_IN_COOKIE_NAME, {
        path: SIGN_IN_COOKIE_PATH,
        secure: isHttpsRequest(context),
      });
    },
  };
}

/**
 * Whether the browser reached the Instance over HTTPS, so that cookies are marked `Secure`. The
 * Gateway passes the original scheme in `X-Forwarded-Proto`.
 */
export function isHttpsRequest(context: Context): boolean {
  const forwardedProtocol = context.req.header("x-forwarded-proto")?.split(",")[0].trim();
  return (forwardedProtocol ?? new URL(context.req.url).protocol.replace(":", "")) === "https";
}
