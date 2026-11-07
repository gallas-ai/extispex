import { defineEntity, p } from "@mikro-orm/core";

/**
 * A Project. Deleting one sets `deletedAt`, which stops its API keys at once; its data in the
 * other services is purged later. A name is unique among Projects that are not deleted, through
 * a partial unique index that the migrations create.
 */
export const ProjectRecord = defineEntity({
  name: "ProjectRecord",
  tableName: "projects",
  properties: {
    id: p.string().primary(),
    name: p.string(),
    createdAt: p.datetime(),
    deletedAt: p.datetime().nullable(),
  },
});

/** A Project API key, stored as the SHA-256 hash of the key and the key's first characters. */
export const ApiKeyRecord = defineEntity({
  name: "ApiKeyRecord",
  tableName: "api_keys",
  properties: {
    id: p.string().primary(),
    projectId: p.string(),
    name: p.string(),
    keyPrefix: p.string(),
    keyHash: p.string(),
    createdAt: p.datetime(),
    revokedAt: p.datetime().nullable(),
  },
  uniques: [{ properties: ["keyHash"] }],
  indexes: [{ properties: ["projectId", "createdAt"] }],
});
