import type { IdentityDatabase } from "./identity-database.ts";
import { SignInRecord, UserRecord } from "./identity-entities.ts";
import { generateTimeOrderedId } from "./time-ordered-id.ts";

export interface ActiveSignIn {
  id: string;
  userId: string;
}

/** Browsers' sign-ins, each found by the hash of its cookie value. */
export interface SignInRepository {
  createSignIn(userId: string, tokenHash: string, createdAt: Date, expiresAt: Date): Promise<void>;
  /** The sign-in when it has not expired and its user is active, or null. */
  findActiveSignIn(tokenHash: string, now: Date): Promise<ActiveSignIn | null>;
  extendSignIn(signInId: string, expiresAt: Date): Promise<void>;
  /** Ends the sign-in; an unknown hash changes nothing. */
  deleteSignIn(tokenHash: string): Promise<void>;
  /** Stores a new password hash and ends the user's sign-ins other than this one. */
  changePassword(userId: string, passwordHash: string, keptSignInId: string): Promise<void>;
  /** Removes expired sign-ins, so that the table does not grow with abandoned browsers. */
  deleteExpiredSignIns(now: Date): Promise<void>;
}

export function createSignInRepository(database: IdentityDatabase): SignInRepository {
  return {
    async createSignIn(userId, tokenHash, createdAt, expiresAt) {
      await database.orm.em.fork().insert(SignInRecord, {
        id: generateTimeOrderedId(createdAt),
        userId,
        tokenHash,
        createdAt,
        expiresAt,
      });
    },

    async findActiveSignIn(tokenHash, now) {
      const entityManager = database.orm.em.fork();
      const signInRow = await entityManager.findOne(SignInRecord, {
        tokenHash,
        expiresAt: { $gt: now },
      });
      if (signInRow === null) return null;
      const isUserActive = await entityManager.count(UserRecord, {
        id: signInRow.userId,
        deactivatedAt: null,
      }) > 0;
      return isUserActive ? { id: signInRow.id, userId: signInRow.userId } : null;
    },

    async extendSignIn(signInId, expiresAt) {
      await database.orm.em.fork().nativeUpdate(SignInRecord, { id: signInId }, { expiresAt });
    },

    async deleteSignIn(tokenHash) {
      await database.orm.em.fork().nativeDelete(SignInRecord, { tokenHash });
    },

    async changePassword(userId, passwordHash, keptSignInId) {
      await database.orm.em.fork().transactional(async (entityManager) => {
        await entityManager.nativeUpdate(UserRecord, { id: userId }, { passwordHash });
        await entityManager.nativeDelete(SignInRecord, { userId, id: { $ne: keptSignInId } });
      });
    },

    async deleteExpiredSignIns(now) {
      await database.orm.em.fork().nativeDelete(SignInRecord, { expiresAt: { $lte: now } });
    },
  };
}
