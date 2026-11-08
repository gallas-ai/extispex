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

/**
 * A person who signs in. A local account has a password hash; users from the company's identity
 * provider will not. A deactivated user keeps their row, so that their email stays taken.
 */
export const UserRecord = defineEntity({
  name: "UserRecord",
  tableName: "users",
  properties: {
    id: p.string().primary(),
    email: p.string(),
    displayName: p.string(),
    passwordHash: p.string().nullable(),
    isInstanceAdmin: p.boolean(),
    createdAt: p.datetime(),
    deactivatedAt: p.datetime().nullable(),
  },
  uniques: [{ properties: ["email"] }],
});

/** A set of users that receives Roles in Projects. Its name is unique in the Instance. */
export const GroupRecord = defineEntity({
  name: "GroupRecord",
  tableName: "groups",
  properties: {
    id: p.string().primary(),
    name: p.string(),
    createdAt: p.datetime(),
  },
  uniques: [{ properties: ["name"] }],
});

export const GroupMemberRecord = defineEntity({
  name: "GroupMemberRecord",
  tableName: "group_members",
  properties: {
    groupId: p.string().primary(),
    userId: p.string().primary(),
    addedAt: p.datetime(),
  },
  indexes: [{ properties: ["userId"] }],
});

/** A Group's Role in a Project; a Group has at most one Role per Project. */
export const RoleAssignmentRecord = defineEntity({
  name: "RoleAssignmentRecord",
  tableName: "role_assignments",
  properties: {
    projectId: p.string().primary(),
    groupId: p.string().primary(),
    role: p.string(),
    assignedAt: p.datetime(),
  },
  indexes: [{ properties: ["groupId"] }],
});

/**
 * A browser's sign-in, found by the SHA-256 hash of the random value in its cookie. It ends at
 * `expiresAt`, which each new access token pushes forward, or when the user signs out.
 */
export const SignInRecord = defineEntity({
  name: "SignInRecord",
  tableName: "sign_ins",
  properties: {
    id: p.string().primary(),
    userId: p.string(),
    tokenHash: p.string(),
    createdAt: p.datetime(),
    expiresAt: p.datetime(),
  },
  uniques: [{ properties: ["tokenHash"] }],
  indexes: [{ properties: ["userId"] }],
});

/**
 * A key pair that signs access tokens, as JSON Web Keys. Every replica signs with the oldest key,
 * and the JWKS endpoint publishes all of them, so a key can be added before the old one goes.
 */
export const SigningKeyRecord = defineEntity({
  name: "SigningKeyRecord",
  tableName: "signing_keys",
  properties: {
    id: p.string().primary(),
    privateKeyJwk: p.text(),
    publicKeyJwk: p.text(),
    createdAt: p.datetime(),
  },
});
