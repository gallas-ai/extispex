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
    /** How many days the services keep the Project's telemetry. */
    retentionDays: p.integer(),
  },
});

/**
 * When a service last removed a deleted Project's data. Each service keeps removing it until it
 * has done so after every access token for the Project expired.
 */
export const ProjectDataRemovalRecord = defineEntity({
  name: "ProjectDataRemovalRecord",
  tableName: "project_data_removals",
  properties: {
    projectId: p.string().primary(),
    service: p.string().primary(),
    removedAt: p.datetime(),
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
 * A person who signs in. A local account has a password hash; a user from the company's identity
 * provider has the provider's issuer and subject instead, which identify them for good while
 * their email may change. A deactivated user keeps their row, so that their email stays taken.
 *
 * `directorySource` says that the company's directory manages the user. Such a user may have
 * neither a password nor an issuer and subject yet: the first OIDC sign-in with their verified
 * email links them. `directoryRemovedAt` hides a user the directory deleted from SCIM.
 */
export const UserRecord = defineEntity({
  name: "UserRecord",
  tableName: "users",
  properties: {
    id: p.string().primary(),
    email: p.string(),
    displayName: p.string(),
    passwordHash: p.string().nullable(),
    oidcIssuer: p.string().nullable(),
    oidcSubject: p.string().nullable(),
    directorySource: p.string().nullable(),
    directoryUserName: p.string().nullable(),
    directoryExternalId: p.string().nullable(),
    directoryRemovedAt: p.datetime().nullable(),
    isInstanceAdmin: p.boolean(),
    createdAt: p.datetime(),
    deactivatedAt: p.datetime().nullable(),
    /** When the user's personal data was deleted for good, 30 days after deactivation. */
    personalDataDeletedAt: p.datetime().nullable(),
  },
  uniques: [
    { properties: ["email"] },
    { properties: ["oidcIssuer", "oidcSubject"] },
    { properties: ["directoryUserName"] },
  ],
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

/**
 * A user's membership of a Group. `isFromCompanyGroup` marks one that a Company group created:
 * sign-in removes only those, so that a member added by hand stays.
 */
export const GroupMemberRecord = defineEntity({
  name: "GroupMemberRecord",
  tableName: "group_members",
  properties: {
    groupId: p.string().primary(),
    userId: p.string().primary(),
    addedAt: p.datetime(),
    isFromCompanyGroup: p.boolean(),
  },
  indexes: [{ properties: ["userId"] }],
});

/** A Company group, as the identity provider names it, whose members join the Group. */
export const CompanyGroupMappingRecord = defineEntity({
  name: "CompanyGroupMappingRecord",
  tableName: "company_group_mappings",
  properties: {
    companyGroupName: p.string().primary(),
    groupId: p.string().primary(),
  },
  indexes: [{ properties: ["groupId"] }],
});

/**
 * A Company group that the directory or an import told Identity about. It is a copy of the
 * directory and holds no permissions: only a mapping to a Group gives its members anything.
 */
export const CompanyGroupRecord = defineEntity({
  name: "CompanyGroupRecord",
  tableName: "company_groups",
  properties: {
    id: p.string().primary(),
    displayName: p.string(),
    externalId: p.string().nullable(),
    source: p.string(),
    createdAt: p.datetime(),
  },
  uniques: [{ properties: ["displayName"] }],
  indexes: [{ properties: ["externalId"] }],
});

/** Who is in a Company group according to the directory. */
export const CompanyGroupMemberRecord = defineEntity({
  name: "CompanyGroupMemberRecord",
  tableName: "company_group_members",
  properties: {
    companyGroupId: p.string().primary(),
    userId: p.string().primary(),
    addedAt: p.datetime(),
  },
  indexes: [{ properties: ["userId"] }],
});

/** Lets the company's directory call the SCIM endpoints, stored as a SHA-256 hash. */
export const DirectoryTokenRecord = defineEntity({
  name: "DirectoryTokenRecord",
  tableName: "directory_tokens",
  properties: {
    id: p.string().primary(),
    name: p.string(),
    tokenPrefix: p.string(),
    tokenHash: p.string(),
    createdAt: p.datetime(),
    lastUsedAt: p.datetime().nullable(),
    revokedAt: p.datetime().nullable(),
  },
  uniques: [{ properties: ["tokenHash"] }],
});

/** One applied file, for the sync status on the Access page. */
export const DirectoryImportRecord = defineEntity({
  name: "DirectoryImportRecord",
  tableName: "directory_imports",
  properties: {
    id: p.string().primary(),
    importedAt: p.datetime(),
    importedByUserId: p.string(),
    format: p.string(),
    rowCount: p.integer(),
    createdCount: p.integer(),
    updatedCount: p.integer(),
    deactivatedCount: p.integer(),
    unchangedCount: p.integer(),
  },
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
 * An OIDC sign-in between the redirect to the identity provider and the way back, found by the
 * hash of its `state`. The cookie's hash ties it to the browser that started it.
 */
export const OidcSignInAttemptRecord = defineEntity({
  name: "OidcSignInAttemptRecord",
  tableName: "oidc_sign_in_attempts",
  properties: {
    stateHash: p.string().primary(),
    browserBindingHash: p.string(),
    nonce: p.string(),
    codeVerifier: p.string(),
    returnTo: p.text(),
    expiresAt: p.datetime(),
  },
});

/**
 * Password attempts for one account or address in a fixed time window. The key is hashed, so the
 * table does not list who is being guessed at. Time is in whole seconds, because the counting
 * statement compares it and the two databases store dates differently.
 */
export const SignInThrottleRecord = defineEntity({
  name: "SignInThrottleRecord",
  tableName: "sign_in_throttles",
  properties: {
    keyHash: p.string().primary(),
    attemptCount: p.integer(),
    windowEndsAtEpochSeconds: p.bigint("number"),
  },
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
    /** The private key as a JWK, encrypted with the master key. */
    sealedPrivateKeyJwk: p.text().fieldName("private_key_jwk"),
    publicKeyJwk: p.text(),
    createdAt: p.datetime(),
  },
});
