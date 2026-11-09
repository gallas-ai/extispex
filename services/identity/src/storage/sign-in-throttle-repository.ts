import type { IdentityDatabase } from "./identity-database.ts";
import { SignInThrottleRecord } from "./identity-entities.ts";

export interface ThrottleWindow {
  attemptCount: number;
  windowEndsAtEpochSeconds: number;
}

/** Counts password attempts per key in fixed time windows, shared by every replica. */
export interface SignInThrottleRepository {
  /** Counts one attempt in the key's window, or in a new one if the last has ended. */
  countAttempt(
    keyHash: string,
    nowEpochSeconds: number,
    newWindowEndsAtEpochSeconds: number,
  ): Promise<ThrottleWindow>;
  /** Takes one attempt back, for a right password on an address that many people share. */
  releaseAttempt(keyHash: string): Promise<void>;
  /** Forgets the key's attempts, for a right password on the account. */
  clearAttempts(keyHash: string): Promise<void>;
  /** Removes ended windows, so that the table does not grow with every guessed address. */
  deleteEndedWindows(nowEpochSeconds: number): Promise<void>;
}

export function createSignInThrottleRepository(
  database: IdentityDatabase,
): SignInThrottleRepository {
  return {
    async countAttempt(keyHash, nowEpochSeconds, newWindowEndsAtEpochSeconds) {
      // One statement, so that concurrent guesses cannot read the same count.
      const rows = await database.orm.em.fork().execute<
        { attempt_count: number | string; window_ends_at_epoch_seconds: number | string }[]
      >(
        `insert into sign_in_throttles (key_hash, attempt_count, window_ends_at_epoch_seconds)
         values (?, 1, ?)
         on conflict (key_hash) do update set
           attempt_count = case
             when sign_in_throttles.window_ends_at_epoch_seconds <= ? then 1
             else sign_in_throttles.attempt_count + 1 end,
           window_ends_at_epoch_seconds = case
             when sign_in_throttles.window_ends_at_epoch_seconds <= ?
               then excluded.window_ends_at_epoch_seconds
             else sign_in_throttles.window_ends_at_epoch_seconds end
         returning attempt_count, window_ends_at_epoch_seconds`,
        [keyHash, newWindowEndsAtEpochSeconds, nowEpochSeconds, nowEpochSeconds],
      );
      return {
        attemptCount: Number(rows[0].attempt_count),
        windowEndsAtEpochSeconds: Number(rows[0].window_ends_at_epoch_seconds),
      };
    },

    async releaseAttempt(keyHash) {
      await database.orm.em.fork().execute(
        `update sign_in_throttles set attempt_count = attempt_count - 1
         where key_hash = ? and attempt_count > 0`,
        [keyHash],
      );
    },

    async clearAttempts(keyHash) {
      await database.orm.em.fork().nativeDelete(SignInThrottleRecord, { keyHash });
    },

    async deleteEndedWindows(nowEpochSeconds) {
      await database.orm.em.fork().nativeDelete(SignInThrottleRecord, {
        windowEndsAtEpochSeconds: { $lte: nowEpochSeconds },
      });
    },
  };
}
