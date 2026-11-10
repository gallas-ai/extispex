import type { DirectoryToken } from "@extispex/contracts";
import type { InferEntity } from "@mikro-orm/core";
import type { IdentityDatabase } from "./identity-database.ts";
import { DirectoryTokenRecord } from "./identity-entities.ts";
import { generateTimeOrderedId } from "./time-ordered-id.ts";

type DirectoryTokenRow = InferEntity<typeof DirectoryTokenRecord>;

/** A token's use is stored at most once a minute, so that a sync of many users stays cheap. */
const LAST_USED_PRECISION_MILLISECONDS = 60_000;

/** Tokens that let the company's directory call the SCIM endpoints. */
export interface DirectoryTokenRepository {
  createToken(
    newToken: { name: string; tokenPrefix: string; tokenHash: string },
    createdAt: Date,
  ): Promise<DirectoryToken>;
  /** Newest first, revoked ones included. */
  listTokens(): Promise<DirectoryToken[]>;
  /** False for an unknown token. Revoking twice keeps the first date. */
  revokeToken(tokenId: string, revokedAt: Date): Promise<boolean>;
  /** The ID of the token with this hash that is not revoked, or null. */
  findActiveTokenId(tokenHash: string): Promise<string | null>;
  recordTokenUse(tokenId: string, usedAt: Date): Promise<void>;
}

export function createDirectoryTokenRepository(
  database: IdentityDatabase,
): DirectoryTokenRepository {
  return {
    async createToken(newToken, createdAt) {
      const tokenRow = {
        id: generateTimeOrderedId(createdAt),
        ...newToken,
        createdAt,
        lastUsedAt: null,
        revokedAt: null,
      };
      await database.orm.em.fork().insert(DirectoryTokenRecord, tokenRow);
      return toDirectoryToken(tokenRow);
    },

    async listTokens() {
      const tokenRows = await database.orm.em.fork().find(DirectoryTokenRecord, {}, {
        orderBy: { createdAt: "desc", id: "desc" },
      });
      return tokenRows.map(toDirectoryToken);
    },

    async revokeToken(tokenId, revokedAt) {
      const entityManager = database.orm.em.fork();
      if (await entityManager.count(DirectoryTokenRecord, { id: tokenId }) === 0) return false;
      await entityManager.nativeUpdate(
        DirectoryTokenRecord,
        { id: tokenId, revokedAt: null },
        { revokedAt },
      );
      return true;
    },

    async findActiveTokenId(tokenHash) {
      const tokenRow = await database.orm.em.fork().findOne(DirectoryTokenRecord, {
        tokenHash,
        revokedAt: null,
      });
      return tokenRow?.id ?? null;
    },

    async recordTokenUse(tokenId, usedAt) {
      await database.orm.em.fork().nativeUpdate(DirectoryTokenRecord, {
        id: tokenId,
        $or: [
          { lastUsedAt: null },
          { lastUsedAt: { $lt: new Date(usedAt.getTime() - LAST_USED_PRECISION_MILLISECONDS) } },
        ],
      }, { lastUsedAt: usedAt });
    },
  };
}

function toDirectoryToken(tokenRow: DirectoryTokenRow): DirectoryToken {
  return {
    id: tokenRow.id,
    name: tokenRow.name,
    tokenPrefix: tokenRow.tokenPrefix,
    createdAt: tokenRow.createdAt.toISOString(),
    lastUsedAt: tokenRow.lastUsedAt ? tokenRow.lastUsedAt.toISOString() : null,
    revokedAt: tokenRow.revokedAt ? tokenRow.revokedAt.toISOString() : null,
  };
}
