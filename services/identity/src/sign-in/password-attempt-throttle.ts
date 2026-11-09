import { hashRandomSecret } from "../api-keys/api-key-secrets.ts";
import type { SignInThrottleRepository } from "../storage/sign-in-throttle-repository.ts";

/** How long a window lasts, and so the longest wait for someone who was throttled. */
export const THROTTLE_WINDOW_SECONDS = 15 * 60;
/** Wrong passwords for one account per window, which is far above a person's mistakes. */
export const MAXIMUM_ATTEMPTS_PER_ACCOUNT = 10;
/** Wrong passwords per address and window, higher because a company shares one address. */
export const MAXIMUM_ATTEMPTS_PER_ADDRESS = 100;

export type PasswordAttempt =
  | { status: "blocked"; retryAfterSeconds: number }
  | { status: "allowed"; markSucceeded(): Promise<void> };

export interface PasswordAttemptThrottle {
  /**
   * Counts a password attempt before the password is checked, so that parallel guesses cannot
   * pass the limit while the hash is computed. An unknown email counts like a known one, so the
   * answer does not reveal who has an account.
   */
  beginAttempt(email: string, clientAddress: string | null): Promise<PasswordAttempt>;
}

export function createPasswordAttemptThrottle(
  repository: SignInThrottleRepository,
  readCurrentTime: () => Date,
): PasswordAttemptThrottle {
  return {
    async beginAttempt(email, clientAddress) {
      const nowEpochSeconds = Math.floor(readCurrentTime().getTime() / 1000);
      await repository.deleteEndedWindows(nowEpochSeconds);
      const countAttempt = async (key: string, limit: number) => {
        const keyHash = await hashRandomSecret(key);
        const window = await repository.countAttempt(
          keyHash,
          nowEpochSeconds,
          nowEpochSeconds + THROTTLE_WINDOW_SECONDS,
        );
        return { keyHash, window, isOverLimit: window.attemptCount > limit };
      };
      const account = await countAttempt(`account:${email}`, MAXIMUM_ATTEMPTS_PER_ACCOUNT);
      const address = clientAddress === null
        ? null
        : await countAttempt(`address:${clientAddress}`, MAXIMUM_ATTEMPTS_PER_ADDRESS);
      const blockingWindows = [account, address]
        .filter((counted) => counted?.isOverLimit)
        .map((counted) => counted!.window.windowEndsAtEpochSeconds);
      if (blockingWindows.length > 0) {
        return {
          status: "blocked",
          retryAfterSeconds: Math.max(1, Math.max(...blockingWindows) - nowEpochSeconds),
        };
      }
      return {
        status: "allowed",
        markSucceeded: async () => {
          await repository.clearAttempts(account.keyHash);
          if (address !== null) await repository.releaseAttempt(address.keyHash);
        },
      };
    },
  };
}
