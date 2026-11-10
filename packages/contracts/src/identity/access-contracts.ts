import { z } from "zod";

/** The Roles a Group can have in a Project, from least to most allowed. */
export const ROLES = ["viewer", "editor", "admin"] as const;

/**
 * What a Group may do in a Project: a `viewer` reads its data, an `editor` also changes it, and an
 * `admin` also manages its Role assignments and API keys.
 */
export const roleSchema = z.enum(ROLES);

export type Role = z.infer<typeof roleSchema>;

/** Whether `role` allows everything that `requiredRole` allows. */
export function isRoleAtLeast(role: Role, requiredRole: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(requiredRole);
}

/** The higher of two Roles, for a user who gets Roles in a Project through several Groups. */
export function pickHigherRole(firstRole: Role | null, secondRole: Role | null): Role | null {
  if (firstRole === null) return secondRole;
  if (secondRole === null) return firstRole;
  return isRoleAtLeast(firstRole, secondRole) ? firstRole : secondRole;
}

/** A user signs in with their email address, which is unique in the Instance and kept lowercase. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const displayNameSchema = z.string().trim().min(1).max(100);

/** Long enough to resist guessing without forcing character classes, as NIST SP 800-63B advises. */
export const MINIMUM_PASSWORD_LENGTH = 12;
export const passwordSchema = z.string().min(MINIMUM_PASSWORD_LENGTH).max(256);

export const groupNameSchema = z.string().trim().min(1).max(64);

/** A group's name or ID in the company's identity system, exactly as its token carries it. */
export const companyGroupNameSchema = z.string().trim().min(1).max(255);

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  /** Manages Projects, Groups and users. Reads a Project's data only through a Role. */
  isInstanceAdmin: z.boolean(),
  /** Whether the user signs in with a password stored by Identity. */
  isLocalAccount: z.boolean(),
  /** How the company's directory reached this user: `scim`, `import`, or null for neither. */
  directorySource: z.enum(["scim", "import"]).nullable(),
  createdAt: z.string(),
  /** When the user lost access, or null while they have it. */
  deactivatedAt: z.string().nullable(),
});

export const createUserRequestSchema = z.object({
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  isInstanceAdmin: z.boolean().default(false),
});

/** Only the fields present change. A deactivated user is signed out at once. */
export const updateUserRequestSchema = z.object({
  displayName: displayNameSchema.optional(),
  password: passwordSchema.optional(),
  isInstanceAdmin: z.boolean().optional(),
  isDeactivated: z.boolean().optional(),
});

export const listUsersResponseSchema = z.object({ users: z.array(userSchema) });

export const groupMemberSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  /** Whether a Company group added the user. Sign-in then adds or removes them again. */
  isFromCompanyGroup: z.boolean(),
});

export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** By email. */
  members: z.array(groupMemberSchema),
  /** The Company groups whose members join this Group, by name. */
  companyGroups: z.array(z.string()),
});

export const createGroupRequestSchema = z.object({ name: groupNameSchema });

export const listGroupsResponseSchema = z.object({ groups: z.array(groupSchema) });

/** Replaces all the Group's Company groups. Permissions are never imported, only membership. */
export const setCompanyGroupsRequestSchema = z.object({
  companyGroups: z.array(companyGroupNameSchema).max(100),
});

export const roleAssignmentSchema = z.object({
  groupId: z.string(),
  groupName: z.string(),
  role: roleSchema,
  assignedAt: z.string(),
});

export const assignRoleRequestSchema = z.object({ role: roleSchema });

export const listRoleAssignmentsResponseSchema = z.object({
  roleAssignments: z.array(roleAssignmentSchema),
});

export const signInRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

/** What the sign-in page offers on this Instance. */
export const signInOptionsSchema = z.object({
  /** Whether users can sign in with a password stored by Identity. */
  areLocalAccountsEnabled: z.boolean(),
  /** The name to show for the company's identity provider, or null without OIDC. */
  oidcProviderName: z.string().nullable(),
});

export const changeOwnPasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const issueAccessTokenRequestSchema = z.object({
  /** The Project the token acts on. Without it, the token only manages access. */
  projectId: z.string().min(1).max(64).optional(),
});

export const accessTokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  projectId: z.string().nullable(),
  /** The caller's Role in the Project, or null for a token without a Project. */
  role: roleSchema.nullable(),
});

export type User = z.infer<typeof userSchema>;
export type CreateUserRequest = z.input<typeof createUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export type ListUsersResponse = z.infer<typeof listUsersResponseSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type Group = z.infer<typeof groupSchema>;
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;
export type ListGroupsResponse = z.infer<typeof listGroupsResponseSchema>;
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;
export type AssignRoleRequest = z.infer<typeof assignRoleRequestSchema>;
export type ListRoleAssignmentsResponse = z.infer<typeof listRoleAssignmentsResponseSchema>;
export type SignInRequest = z.infer<typeof signInRequestSchema>;
export type SignInOptions = z.infer<typeof signInOptionsSchema>;
export type ChangeOwnPasswordRequest = z.infer<typeof changeOwnPasswordRequestSchema>;
export type SetCompanyGroupsRequest = z.infer<typeof setCompanyGroupsRequestSchema>;
export type IssueAccessTokenRequest = z.infer<typeof issueAccessTokenRequestSchema>;
export type AccessTokenResponse = z.infer<typeof accessTokenResponseSchema>;
