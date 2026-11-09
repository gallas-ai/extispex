import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { accessTokenSecurity, describeErrorResponse } from "../openapi-route-parts.ts";
import {
  accessTokenResponseSchema,
  assignRoleRequestSchema,
  changeOwnPasswordRequestSchema,
  createGroupRequestSchema,
  createUserRequestSchema,
  groupSchema,
  issueAccessTokenRequestSchema,
  listGroupsResponseSchema,
  listRoleAssignmentsResponseSchema,
  listUsersResponseSchema,
  roleAssignmentSchema,
  setCompanyGroupsRequestSchema,
  signInOptionsSchema,
  signInRequestSchema,
  updateUserRequestSchema,
  userSchema,
} from "./access-contracts.ts";

/** The cookie that keeps a browser signed in. It is sent only to the sign-in endpoints. */
export const SIGN_IN_COOKIE_NAME = "extispex_sign_in";
export const SIGN_IN_COOKIE_PATH = "/v1/sign-in";

/**
 * The value that ties an OIDC sign-in to the browser that started it. Its path covers only the
 * OIDC endpoints, and it is `SameSite=Lax` because the identity provider's redirect comes from
 * another site.
 */
export const OIDC_ATTEMPT_COOKIE_NAME = "extispex_oidc_attempt";
export const OIDC_SIGN_IN_PATH = "/v1/sign-in/oidc";

/** Added to the UI's address when an OIDC sign-in fails; its value is an `OidcSignInFailure`. */
export const SIGN_IN_FAILURE_PARAMETER = "signInError";

export const OIDC_SIGN_IN_FAILURES = [
  "oidc_disabled",
  "attempt_expired",
  "provider_unavailable",
  "provider_refused",
  "email_missing",
  "email_taken",
  "user_deactivated",
] as const;

export type OidcSignInFailure = (typeof OIDC_SIGN_IN_FAILURES)[number];

const SIGN_IN_TAGS = ["Sign-in"];
const ACCESS_TAGS = ["Access"];

const idParameter = z.string().min(1).max(64);
const userPathParameters = z.object({ userId: idParameter });
const groupPathParameters = z.object({ groupId: idParameter });
const groupMemberPathParameters = groupPathParameters.extend({ userId: idParameter });
const roleAssignmentsPathParameters = z.object({ projectId: idParameter });
const roleAssignmentPathParameters = roleAssignmentsPathParameters.extend({
  groupId: idParameter,
});

function jsonBody<Schema extends z.ZodType>(schema: Schema) {
  return { content: { "application/json": { schema } }, required: true };
}

function jsonResponse<Schema extends z.ZodType>(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema } } };
}

const accessErrorResponses = {
  400: describeErrorResponse("The request is invalid."),
  401: describeErrorResponse("The access token is missing, invalid or not a user's."),
  403: describeErrorResponse("The user is not allowed to do this."),
};

const userNotFound = describeErrorResponse("No user with this ID exists.");
const groupNotFound = describeErrorResponse("No Group with this ID exists.");

const tooManyAttempts = describeErrorResponse(
  "Too many wrong passwords for this account or address. `Retry-After` says when to try again.",
);

export const signInRoute = createRoute({
  method: "post",
  path: "/v1/sign-in",
  summary: "Sign in with a local account. The response sets the sign-in cookie.",
  tags: SIGN_IN_TAGS,
  request: { body: jsonBody(signInRequestSchema) },
  responses: {
    200: jsonResponse("The signed-in user.", userSchema),
    400: describeErrorResponse("The request is invalid."),
    401: describeErrorResponse("The email address or password is wrong."),
    403: describeErrorResponse("Local accounts are disabled on this Instance."),
    429: tooManyAttempts,
  },
});

export const getSignInOptionsRoute = createRoute({
  method: "get",
  path: "/v1/sign-in/options",
  summary: "Tell how people sign in on this Instance. Needs no credentials.",
  tags: SIGN_IN_TAGS,
  responses: { 200: jsonResponse("The ways to sign in.", signInOptionsSchema) },
});

export const startOidcSignInRoute = createRoute({
  method: "get",
  path: `${OIDC_SIGN_IN_PATH}/authorize`,
  summary: "Send the browser to the company's identity provider, with PKCE.",
  tags: SIGN_IN_TAGS,
  request: { query: z.object({ returnTo: z.string().max(2048).optional() }) },
  responses: {
    302: {
      description: "To the identity provider, or back to the UI with `signInError` on a failure.",
    },
  },
});

export const completeOidcSignInRoute = createRoute({
  method: "get",
  path: `${OIDC_SIGN_IN_PATH}/callback`,
  summary: "Where the identity provider sends the browser back. Starts the sign-in.",
  tags: SIGN_IN_TAGS,
  responses: {
    302: { description: "Back to the UI, signed in, or with `signInError` on a failure." },
  },
});

export const changeOwnPasswordRoute = createRoute({
  method: "put",
  path: "/v1/sign-in/password",
  summary: "Change the signed-in user's own password and end their other sign-ins.",
  tags: SIGN_IN_TAGS,
  request: { body: jsonBody(changeOwnPasswordRequestSchema) },
  responses: {
    204: { description: "The password is changed." },
    400: describeErrorResponse("The request is invalid."),
    401: describeErrorResponse("The browser is not signed in, or the sign-in has expired."),
    403: describeErrorResponse("The current password is wrong, or this is not a local account."),
    429: tooManyAttempts,
  },
});

export const signOutRoute = createRoute({
  method: "delete",
  path: "/v1/sign-in",
  summary: "Sign out: end the sign-in of the cookie and clear the cookie.",
  tags: SIGN_IN_TAGS,
  responses: { 204: { description: "Signed out, now or earlier." } },
});

export const issueUserAccessTokenRoute = createRoute({
  method: "post",
  path: "/v1/sign-in/access-tokens",
  summary: "Issue a short-lived access token for the signed-in user, optionally for one Project.",
  tags: SIGN_IN_TAGS,
  request: { body: jsonBody(issueAccessTokenRequestSchema) },
  responses: {
    200: jsonResponse("The token and the user's Role in the Project.", accessTokenResponseSchema),
    400: describeErrorResponse("The request is invalid."),
    401: describeErrorResponse("The browser is not signed in, or the sign-in has expired."),
    403: describeErrorResponse("The user has no Role in the Project."),
    404: describeErrorResponse("No Project with this ID exists, or it is deleted."),
  },
});

export const getCurrentUserRoute = createRoute({
  method: "get",
  path: "/v1/me",
  summary: "Get the user the access token belongs to.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse("The user.", userSchema),
    401: accessErrorResponses[401],
  },
});

export const listUsersRoute = createRoute({
  method: "get",
  path: "/v1/users",
  summary: "List the Instance's users by email. Takes an Instance admin.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse("The users.", listUsersResponseSchema),
    ...accessErrorResponses,
  },
});

export const createUserRoute = createRoute({
  method: "post",
  path: "/v1/users",
  summary: "Create a local account. Takes an Instance admin and enabled local accounts.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { body: jsonBody(createUserRequestSchema) },
  responses: {
    201: jsonResponse("The new user.", userSchema),
    ...accessErrorResponses,
    409: describeErrorResponse("A user with this email address already exists."),
  },
});

export const updateUserRoute = createRoute({
  method: "patch",
  path: "/v1/users/{userId}",
  summary: "Change a user's name, password, Instance admin status or deactivation. Takes an " +
    "Instance admin.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { params: userPathParameters, body: jsonBody(updateUserRequestSchema) },
  responses: {
    200: jsonResponse("The changed user.", userSchema),
    ...accessErrorResponses,
    404: userNotFound,
    409: describeErrorResponse("The change would leave the Instance without an active admin."),
  },
});

export const listGroupsRoute = createRoute({
  method: "get",
  path: "/v1/groups",
  summary: "List the Groups by name, with their members. Takes any signed-in user, so that a " +
    "Project's `admin` can assign Roles.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse("The Groups.", listGroupsResponseSchema),
    401: accessErrorResponses[401],
  },
});

export const createGroupRoute = createRoute({
  method: "post",
  path: "/v1/groups",
  summary: "Create a Group. Takes an Instance admin.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { body: jsonBody(createGroupRequestSchema) },
  responses: {
    201: jsonResponse("The new Group.", groupSchema),
    ...accessErrorResponses,
    409: describeErrorResponse("A Group with this name already exists."),
  },
});

export const deleteGroupRoute = createRoute({
  method: "delete",
  path: "/v1/groups/{groupId}",
  summary: "Delete a Group and its Role assignments. Takes an Instance admin.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { params: groupPathParameters },
  responses: {
    204: { description: "The Group is deleted." },
    ...accessErrorResponses,
    404: groupNotFound,
  },
});

export const addGroupMemberRoute = createRoute({
  method: "put",
  path: "/v1/groups/{groupId}/members/{userId}",
  summary: "Add a user to a Group. Takes an Instance admin.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { params: groupMemberPathParameters },
  responses: {
    200: jsonResponse("The Group with its members.", groupSchema),
    ...accessErrorResponses,
    404: describeErrorResponse("The Group or the user does not exist."),
  },
});

export const removeGroupMemberRoute = createRoute({
  method: "delete",
  path: "/v1/groups/{groupId}/members/{userId}",
  summary: "Remove a user from a Group. Takes an Instance admin.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { params: groupMemberPathParameters },
  responses: {
    200: jsonResponse("The Group with its members.", groupSchema),
    ...accessErrorResponses,
    404: groupNotFound,
  },
});

export const setCompanyGroupsRoute = createRoute({
  method: "put",
  path: "/v1/groups/{groupId}/company-groups",
  summary: "Replace the Company groups whose members join this Group when they sign in. Takes an " +
    "Instance admin.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { params: groupPathParameters, body: jsonBody(setCompanyGroupsRequestSchema) },
  responses: {
    200: jsonResponse("The Group with its Company groups.", groupSchema),
    ...accessErrorResponses,
    404: groupNotFound,
  },
});

export const listRoleAssignmentsRoute = createRoute({
  method: "get",
  path: "/v1/projects/{projectId}/role-assignments",
  summary: "List the Groups with a Role in a Project. Takes the Project's `admin` or an Instance " +
    "admin.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { params: roleAssignmentsPathParameters },
  responses: {
    200: jsonResponse("The Role assignments by Group name.", listRoleAssignmentsResponseSchema),
    ...accessErrorResponses,
    404: describeErrorResponse("No Project with this ID exists, or it is deleted."),
  },
});

export const assignRoleRoute = createRoute({
  method: "put",
  path: "/v1/projects/{projectId}/role-assignments/{groupId}",
  summary: "Give a Group a Role in a Project, replacing its previous Role there. Takes the " +
    "Project's `admin` or an Instance admin. Members' tokens change within five minutes.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { params: roleAssignmentPathParameters, body: jsonBody(assignRoleRequestSchema) },
  responses: {
    200: jsonResponse("The Role assignment.", roleAssignmentSchema),
    ...accessErrorResponses,
    404: describeErrorResponse("The Project or the Group does not exist."),
  },
});

export const removeRoleAssignmentRoute = createRoute({
  method: "delete",
  path: "/v1/projects/{projectId}/role-assignments/{groupId}",
  summary: "Take a Group's Role in a Project away. Takes the Project's `admin` or an Instance " +
    "admin. Members' tokens change within five minutes.",
  tags: ACCESS_TAGS,
  security: accessTokenSecurity,
  request: { params: roleAssignmentPathParameters },
  responses: {
    204: { description: "The Group has no Role in the Project, now or earlier." },
    ...accessErrorResponses,
    404: describeErrorResponse("No Project with this ID exists, or it is deleted."),
  },
});

/** Sign-in, users, Groups and Role assignments, all reachable through the Gateway. */
export const accessRoutes = [
  getSignInOptionsRoute,
  startOidcSignInRoute,
  completeOidcSignInRoute,
  changeOwnPasswordRoute,
  signInRoute,
  signOutRoute,
  issueUserAccessTokenRoute,
  getCurrentUserRoute,
  listUsersRoute,
  createUserRoute,
  updateUserRoute,
  listGroupsRoute,
  createGroupRoute,
  deleteGroupRoute,
  addGroupMemberRoute,
  removeGroupMemberRoute,
  setCompanyGroupsRoute,
  listRoleAssignmentsRoute,
  assignRoleRoute,
  removeRoleAssignmentRoute,
];
