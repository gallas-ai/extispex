import type { User } from "@extispex/contracts";
import { type EntityManager, UniqueConstraintViolationException } from "@mikro-orm/core";
import { toUser } from "./access-repository.ts";
import { findCompanyGroupsOfUser, listCompanyGroupNames } from "./directory-memberships.ts";
import type { IdentityDatabase } from "./identity-database.ts";
import {
  CompanyGroupMappingRecord,
  GroupMemberRecord,
  OidcSignInAttemptRecord,
  UserRecord,
} from "./identity-entities.ts";
import { generateTimeOrderedId } from "./time-ordered-id.ts";

export interface OidcSignInAttempt {
  stateHash: string;
  browserBindingHash: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: Date;
}

/** What the identity provider says about the person signing in. */
export interface OidcUserIdentity {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  companyGroups: string[];
}

export type OidcUserSignIn =
  | { status: "signed_in"; user: User }
  | { status: "email_taken" }
  | { status: "deactivated" };

/** OIDC sign-ins in progress, and users and Group memberships that come from them. */
export interface OidcRepository {
  createAttempt(attempt: OidcSignInAttempt, now: Date): Promise<void>;
  /** Finds the attempt and removes it, so that a `state` works once. Null when already used. */
  consumeAttempt(stateHash: string): Promise<OidcSignInAttempt | null>;
  /**
   * Finds or creates the user by issuer and subject, updates their email and name, and makes
   * their Group memberships from Company groups match `companyGroups` and what the directory says.
   * The only match by email is the first sign-in of someone the directory or an import created,
   * who has no issuer and subject yet; a local account is never matched, because whoever controls
   * an address at the identity provider would take over that account.
   */
  signInUser(identity: OidcUserIdentity, now: Date): Promise<OidcUserSignIn>;
}

/** Two sign-ins of one person linked their user at once; the loser starts over. */
class UserLinkedConcurrently extends Error {}

export function createOidcRepository(database: IdentityDatabase): OidcRepository {
  const signInUserOnce = (identity: OidcUserIdentity, now: Date) =>
    database.orm.em.fork().transactional(async (entityManager): Promise<OidcUserSignIn> => {
      const existingRow = await entityManager.findOne(UserRecord, {
        oidcIssuer: identity.issuer,
        oidcSubject: identity.subject,
      }) ?? await linkProvisionedUser(entityManager, identity);
      if (existingRow?.deactivatedAt) return { status: "deactivated" };
      const isEmailUsedByAnother = await entityManager.count(UserRecord, {
        email: identity.email,
        ...(existingRow === null ? {} : { id: { $ne: existingRow.id } }),
      }) > 0;
      if (existingRow === null && isEmailUsedByAnother) return { status: "email_taken" };

      let userRow;
      if (existingRow === null) {
        userRow = {
          id: generateTimeOrderedId(now),
          email: identity.email,
          displayName: identity.displayName,
          passwordHash: null,
          oidcIssuer: identity.issuer,
          oidcSubject: identity.subject,
          directorySource: null,
          directoryUserName: null,
          directoryExternalId: null,
          directoryRemovedAt: null,
          isInstanceAdmin: false,
          createdAt: now,
          deactivatedAt: null,
          personalDataDeletedAt: null,
        };
        await entityManager.insert(UserRecord, userRow);
      } else {
        // An address that another user holds stays with them; this user keeps their old one.
        const email = isEmailUsedByAnother ? existingRow.email : identity.email;
        userRow = { ...existingRow, email, displayName: identity.displayName };
        await entityManager.nativeUpdate(UserRecord, { id: existingRow.id }, {
          email,
          displayName: identity.displayName,
        });
      }
      await synchronizeMemberships(entityManager, userRow.id, identity.companyGroups, now);
      return { status: "signed_in", user: toUser(userRow) };
    });

  return {
    async createAttempt(attempt, now) {
      const entityManager = database.orm.em.fork();
      await entityManager.nativeDelete(OidcSignInAttemptRecord, { expiresAt: { $lte: now } });
      await entityManager.insert(OidcSignInAttemptRecord, attempt);
    },

    async consumeAttempt(stateHash) {
      const entityManager = database.orm.em.fork();
      const attemptRow = await entityManager.findOne(OidcSignInAttemptRecord, { stateHash });
      if (attemptRow === null) return null;
      // Only the request whose delete removed the row may go on, if two arrive at once.
      const deletedCount = await entityManager.nativeDelete(OidcSignInAttemptRecord, { stateHash });
      return deletedCount === 0 ? null : { ...attemptRow };
    },

    async signInUser(identity, now) {
      try {
        return await signInUserOnce(identity, now);
      } catch (error) {
        const isConcurrentSignIn = error instanceof UniqueConstraintViolationException ||
          error instanceof UserLinkedConcurrently;
        if (!isConcurrentSignIn) throw error;
        // The same user's other tab, or another replica, created or linked the row first.
        return await signInUserOnce(identity, now);
      }
    },
  };
}

/**
 * Links the first sign-in to the user the directory or an import created with this email. Only such
 * a user qualifies: one with a password is a local account, and one with an issuer and subject is
 * already someone else at the identity provider. Null when there is none.
 */
async function linkProvisionedUser(entityManager: EntityManager, identity: OidcUserIdentity) {
  const provisionedRow = await entityManager.findOne(UserRecord, {
    email: identity.email,
    passwordHash: null,
    oidcIssuer: null,
    directorySource: { $ne: null },
  });
  if (provisionedRow === null || provisionedRow.deactivatedAt) return provisionedRow;
  const linkedCount = await entityManager.nativeUpdate(
    UserRecord,
    { id: provisionedRow.id, oidcIssuer: null },
    { oidcIssuer: identity.issuer, oidcSubject: identity.subject },
  );
  if (linkedCount === 0) throw new UserLinkedConcurrently();
  return { ...provisionedRow, oidcIssuer: identity.issuer, oidcSubject: identity.subject };
}

/**
 * Adds the user to the Groups mapped to their Company groups and removes them from Groups they
 * joined that way but no longer qualify for. A Company group counts when the ID token or the
 * directory lists the user in it, so that a token without groups does not undo what SCIM did. A
 * membership added by hand is left alone, as in Grafana's Team Sync, and is not turned into one
 * from a Company group.
 */
async function synchronizeMemberships(
  entityManager: EntityManager,
  userId: string,
  companyGroups: string[],
  now: Date,
): Promise<void> {
  const allCompanyGroupNames = [
    ...companyGroups,
    ...(await findCompanyGroupsOfUser(entityManager, userId)).flatMap(listCompanyGroupNames),
  ];
  const mappingRows = allCompanyGroupNames.length === 0 ? [] : await entityManager.find(
    CompanyGroupMappingRecord,
    { companyGroupName: { $in: allCompanyGroupNames } },
  );
  const entitledGroupIds = new Set(mappingRows.map((mappingRow) => mappingRow.groupId));
  const membershipRows = await entityManager.find(GroupMemberRecord, { userId });
  for (const membershipRow of membershipRows) {
    if (membershipRow.isFromCompanyGroup && !entitledGroupIds.has(membershipRow.groupId)) {
      await entityManager.nativeDelete(GroupMemberRecord, {
        groupId: membershipRow.groupId,
        userId,
      });
    }
  }
  const currentGroupIds = new Set(membershipRows.map((membershipRow) => membershipRow.groupId));
  for (const groupId of entitledGroupIds) {
    if (!currentGroupIds.has(groupId)) {
      await entityManager.insert(GroupMemberRecord, {
        groupId,
        userId,
        addedAt: now,
        isFromCompanyGroup: true,
      });
    }
  }
}
