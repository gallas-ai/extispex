import type {
  CompanyGroupAttributes,
  DirectoryCompanyGroup,
  DirectoryUser,
  DirectoryUserAttributes,
} from "../storage/scim-repository.ts";
import { invalidSyntax, invalidValue, readScimBoolean, ScimRequestError } from "./scim-protocol.ts";
import {
  readCompanyGroupName,
  readDisplayName,
  readEmail,
  readJsonObject,
} from "./scim-resources.ts";

export interface PatchOperation {
  /** Lowercase: Microsoft Entra sends `Replace` where RFC 7644 says `replace`. */
  op: "add" | "replace" | "remove";
  /** Lowercase; attribute names are case-insensitive. Null means the value holds the paths. */
  path: string | null;
  value: unknown;
}

/** Reads a PatchOp message and spreads a value without a path into one operation per attribute. */
export function parsePatchOperations(body: unknown): PatchOperation[] {
  const { Operations: operations } = readJsonObject(body);
  if (!Array.isArray(operations) || operations.length === 0) {
    throw invalidSyntax("Operations must be a non-empty list.");
  }
  return operations.flatMap((operation): PatchOperation[] => {
    const { op, path, value } = readJsonObject(operation);
    const operationName = typeof op === "string" ? op.toLowerCase() : "";
    if (operationName !== "add" && operationName !== "replace" && operationName !== "remove") {
      throw invalidSyntax(`The operation ${String(op)} does not exist.`);
    }
    if (typeof path === "string" && path.trim() !== "") {
      return [{ op: operationName, path: path.trim().toLowerCase(), value }];
    }
    if (operationName === "remove") {
      throw new ScimRequestError(400, "A remove operation needs a path.", "noTarget");
    }
    return Object.entries(readJsonObject(value)).map(([attributePath, attributeValue]) => ({
      op: operationName,
      path: attributePath.toLowerCase(),
      value: attributeValue,
    }));
  });
}

function readString(value: unknown, attributeName: string): string {
  if (typeof value !== "string") throw invalidValue(`${attributeName} must be a string.`);
  return value;
}

const EMAIL_VALUE_PATHS = /^emails(\[[^\]]*\])?(\.value)?$/;

/** Applies the operations to a copy of the user. Attributes the Instance does not keep are ignored. */
export function applyUserPatch(
  currentUser: DirectoryUser,
  operations: PatchOperation[],
): DirectoryUserAttributes {
  const attributes: DirectoryUserAttributes = {
    userName: currentUser.userName,
    email: currentUser.email,
    displayName: currentUser.displayName,
    externalId: currentUser.externalId,
    isActive: currentUser.isActive,
  };
  let givenName: string | undefined;
  let familyName: string | undefined;
  let hasNewEmail = false;
  for (const { op, path, value } of operations) {
    if (op === "remove") {
      if (path === "externalid") attributes.externalId = null;
      continue;
    }
    if (path === "active") {
      attributes.isActive = readScimBoolean(value, "active");
    } else if (path === "username") {
      attributes.userName = readString(value, "userName").trim().toLowerCase();
    } else if (path === "displayname" || path === "name.formatted") {
      attributes.displayName = readDisplayName(readString(value, "displayName"));
    } else if (path === "externalid") {
      attributes.externalId = readString(value, "externalId");
    } else if (path === "name.givenname") {
      givenName = readString(value, "name.givenName");
    } else if (path === "name.familyname") {
      familyName = readString(value, "name.familyName");
    } else if (path === "name") {
      const name = readJsonObject(value);
      if (typeof name.formatted === "string") {
        attributes.displayName = readDisplayName(name.formatted);
      }
      if (typeof name.givenName === "string") givenName = name.givenName;
      if (typeof name.familyName === "string") familyName = name.familyName;
    } else if (path !== null && EMAIL_VALUE_PATHS.test(path)) {
      attributes.email = readEmail(readEmailValue(value));
      hasNewEmail = true;
    }
  }
  // The Instance keeps one name, so half of one cannot change it.
  if (givenName !== undefined && familyName !== undefined) {
    attributes.displayName = readDisplayName(`${givenName} ${familyName}`);
  }
  // A user without a separate email address signs in with their userName.
  if (!hasNewEmail && currentUser.email === currentUser.userName) {
    attributes.email = readEmail(attributes.userName);
  }
  return attributes;
}

function readEmailValue(value: unknown): string {
  if (!Array.isArray(value)) return readString(value, "emails");
  const emails = value.map((email) => readJsonObject(email));
  const primaryEmail = emails.find((email) => email.primary === true) ?? emails[0];
  return readString(primaryEmail?.value, "emails.value");
}

const MEMBER_FILTER_PATH = /^members\[value eq "([^"]+)"\]$/;

/** Applies the operations to a copy of the Company group. */
export function applyGroupPatch(
  currentGroup: DirectoryCompanyGroup,
  operations: PatchOperation[],
): CompanyGroupAttributes {
  const attributes: CompanyGroupAttributes = {
    displayName: currentGroup.displayName,
    externalId: currentGroup.externalId,
    memberIds: currentGroup.members.map((member) => member.id),
  };
  for (const { op, path, value } of operations) {
    if (path === "displayname" && op !== "remove") {
      attributes.displayName = readCompanyGroupName(readString(value, "displayName"));
    } else if (path === "externalid") {
      attributes.externalId = op === "remove" ? null : readString(value, "externalId");
    } else if (path === "members") {
      const memberIds = readMemberIds(value);
      if (op === "add") {
        attributes.memberIds = [...attributes.memberIds, ...memberIds];
      } else if (op === "replace") {
        attributes.memberIds = memberIds;
      } else {
        const removedIds = new Set(memberIds);
        attributes.memberIds = value === undefined
          ? []
          : attributes.memberIds.filter((memberId) => !removedIds.has(memberId));
      }
    } else if (path !== null && op === "remove") {
      // The whole path was lowercased, and so was this ID, so both sides are compared in lowercase.
      const memberId = readFilteredMemberId(path);
      if (memberId !== null) {
        attributes.memberIds = attributes.memberIds.filter((candidate) =>
          candidate.toLowerCase() !== memberId
        );
      }
    }
  }
  return attributes;
}

function readFilteredMemberId(path: string): string | null {
  return MEMBER_FILTER_PATH.exec(path)?.[1] ?? null;
}

function readMemberIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidValue("members must be a list.");
  return value.map((member) => readString(readJsonObject(member).value, "members.value"));
}
