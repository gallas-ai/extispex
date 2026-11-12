import { companyGroupNameSchema, displayNameSchema, emailSchema } from "@extispex/contracts";
import { z } from "zod";
import type {
  CompanyGroupAttributes,
  DirectoryCompanyGroup,
  DirectoryUser,
  DirectoryUserAttributes,
} from "../storage/mod.ts";
import {
  invalidSyntax,
  invalidValue,
  readScimBoolean,
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
} from "./scim-protocol.ts";

const MAXIMUM_DISPLAY_NAME_LENGTH = 100;

const scimUserSchema = z.looseObject({
  userName: z.string().trim().min(1).max(255),
  displayName: z.string().optional(),
  externalId: z.string().max(255).optional(),
  active: z.unknown().optional(),
  name: z.looseObject({
    formatted: z.string().optional(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
  }).optional(),
  emails: z.array(z.looseObject({ value: z.string(), primary: z.unknown().optional() })).optional(),
});

const scimGroupSchema = z.looseObject({
  displayName: z.string(),
  externalId: z.string().max(255).optional(),
  members: z.array(z.looseObject({ value: z.string() })).optional(),
});

function parseResource<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw invalidValue(
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; "),
  );
}

export function readEmail(value: string): string {
  const email = emailSchema.safeParse(value);
  if (!email.success) throw invalidValue(`${value} is not an email address.`);
  return email.data;
}

/** A directory's own name for a person may be longer than the Instance shows. */
export function readDisplayName(value: string): string {
  const displayName = displayNameSchema.safeParse(value.slice(0, MAXIMUM_DISPLAY_NAME_LENGTH));
  if (!displayName.success) throw invalidValue("displayName must not be empty.");
  return displayName.data;
}

export function readCompanyGroupName(value: string): string {
  const name = companyGroupNameSchema.safeParse(value);
  if (!name.success) throw invalidValue("displayName must have 1 to 255 characters.");
  return name.data;
}

/**
 * The attributes of a POST or a PUT. Anything else in the resource is ignored, in particular
 * `roles` and `entitlements`: permissions are never imported. Without `active`, a PUT keeps the
 * current state, as RFC 7644 allows for attributes that the client does not assert.
 */
export function parseUserResource(
  body: unknown,
  currentUser?: DirectoryUser,
): DirectoryUserAttributes {
  const resource = parseResource(scimUserSchema, body);
  const userName = resource.userName.toLowerCase();
  const emails = resource.emails ?? [];
  const primaryEmail = emails.find((email) => email.primary === true || email.primary === "true") ??
    emails[0];
  const composedName = [resource.name?.givenName, resource.name?.familyName]
    .filter((namePart) => namePart !== undefined && namePart.trim() !== "").join(" ");
  const email = readEmail(primaryEmail?.value ?? userName);
  const name = [resource.displayName, resource.name?.formatted, composedName]
    .find((candidate) => candidate !== undefined && candidate.trim() !== "") ?? email.split("@")[0];
  return {
    userName,
    email,
    displayName: readDisplayName(name),
    externalId: resource.externalId ?? currentUser?.externalId ?? null,
    isActive: resource.active === undefined
      ? currentUser?.isActive ?? true
      : readScimBoolean(resource.active, "active"),
  };
}

/** A PUT without `members` keeps the current ones, for the same reason as `active` above. */
export function parseGroupResource(
  body: unknown,
  currentGroup?: DirectoryCompanyGroup,
): CompanyGroupAttributes {
  const resource = parseResource(scimGroupSchema, body);
  return {
    displayName: readCompanyGroupName(resource.displayName),
    externalId: resource.externalId ?? currentGroup?.externalId ?? null,
    memberIds: resource.members?.map((member) => member.value) ??
      currentGroup?.members.map((member) => member.id) ?? [],
  };
}

export function readJsonObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidSyntax("The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function toScimUser(user: DirectoryUser): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    ...(user.externalId === null ? {} : { externalId: user.externalId }),
    userName: user.userName,
    displayName: user.displayName,
    name: { formatted: user.displayName },
    emails: [{ value: user.email, primary: true, type: "work" }],
    active: user.isActive,
    meta: { resourceType: "User", created: user.createdAt.toISOString() },
  };
}

export function toScimGroup(
  companyGroup: DirectoryCompanyGroup,
  includeMembers = true,
): Record<string, unknown> {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: companyGroup.id,
    ...(companyGroup.externalId === null ? {} : { externalId: companyGroup.externalId }),
    displayName: companyGroup.displayName,
    ...(includeMembers
      ? {
        members: companyGroup.members.map((member) => ({
          value: member.id,
          display: member.displayName,
          type: "User",
        })),
      }
      : {}),
    meta: { resourceType: "Group", created: companyGroup.createdAt.toISOString() },
  };
}
