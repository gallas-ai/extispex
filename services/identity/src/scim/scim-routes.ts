import {
  createScimGroupRoute,
  createScimUserRoute,
  deleteScimGroupRoute,
  deleteScimUserRoute,
  getScimGroupRoute,
  getScimServiceProviderConfigRoute,
  getScimUserRoute,
  listScimGroupsRoute,
  listScimResourceTypesRoute,
  listScimSchemasRoute,
  listScimUsersRoute,
  patchScimGroupRoute,
  patchScimUserRoute,
  replaceScimGroupRoute,
  replaceScimUserRoute,
  SCIM_BASE_PATH,
} from "@extispex/contracts";
import { extractBearerToken } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { hashRandomSecret } from "../api-keys/mod.ts";
import type { IdentityEnvironment } from "../access/mod.ts";
import type {
  CompanyGroupFilter,
  DirectoryTokenRepository,
  DirectoryUserFilter,
  ModifyCompanyGroupResult,
  ModifyUserResult,
  SaveCompanyGroupResult,
  SaveUserResult,
  ScimRepository,
} from "../storage/mod.ts";
import { applyGroupPatch, applyUserPatch, parsePatchOperations } from "./scim-patch.ts";
import {
  invalidSyntax,
  invalidValue,
  MAXIMUM_PAGE_SIZE,
  notFound,
  parseEqualityFilter,
  readScimPage,
  respondWithScim,
  respondWithScimError,
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
  ScimRequestError,
  toScimList,
  uniquenessConflict,
} from "./scim-protocol.ts";
import {
  parseGroupResource,
  parseUserResource,
  toScimGroup,
  toScimUser,
} from "./scim-resources.ts";

export interface ScimRouteDependencies {
  scimRepository: ScimRepository;
  directoryTokenRepository: DirectoryTokenRepository;
  readCurrentTime: () => Date;
}

const LAST_INSTANCE_ADMIN_DETAIL = "The Instance needs at least one active Instance admin.";

/** Requires a directory token that is not revoked on every SCIM endpoint. */
function requireDirectoryToken(
  directoryTokenRepository: DirectoryTokenRepository,
  readCurrentTime: () => Date,
): MiddlewareHandler {
  return async (context, next) => {
    const token = extractBearerToken(context.req.header("authorization"));
    const tokenId = token === null
      ? null
      : await directoryTokenRepository.findActiveTokenId(await hashRandomSecret(token));
    if (tokenId === null) {
      return respondWithScimError(
        new ScimRequestError(401, "A valid directory token is required as a Bearer token."),
        { "www-authenticate": "Bearer" },
      );
    }
    await directoryTokenRepository.recordTokenUse(tokenId, readCurrentTime());
    await next();
  };
}

/** Turns a request that SCIM refuses into SCIM's own error format. */
function handleScim(handler: (context: Context) => Promise<Response> | Response) {
  return async (context: Context) => {
    try {
      return await handler(context);
    } catch (error) {
      if (error instanceof ScimRequestError) return respondWithScimError(error);
      throw error;
    }
  };
}

async function readBody(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw invalidSyntax("The request body is not valid JSON.");
  }
}

function readUserFilter(filter: string | undefined): DirectoryUserFilter {
  const parsedFilter = parseEqualityFilter(filter);
  if (parsedFilter === null) return {};
  if (parsedFilter.attributeName === "username") {
    return { userName: parsedFilter.value.toLowerCase() };
  }
  if (parsedFilter.attributeName === "externalid") return { externalId: parsedFilter.value };
  if (parsedFilter.attributeName === "id") return { id: parsedFilter.value };
  throw new ScimRequestError(400, `Filtering by ${filter} is not supported.`, "invalidFilter");
}

function readGroupFilter(filter: string | undefined): CompanyGroupFilter {
  const parsedFilter = parseEqualityFilter(filter);
  if (parsedFilter === null) return {};
  if (parsedFilter.attributeName === "displayname") return { displayName: parsedFilter.value };
  if (parsedFilter.attributeName === "externalid") return { externalId: parsedFilter.value };
  if (parsedFilter.attributeName === "id") return { id: parsedFilter.value };
  throw new ScimRequestError(400, `Filtering by ${filter} is not supported.`, "invalidFilter");
}

function unwrapSavedUser(result: SaveUserResult | ModifyUserResult, userId?: string) {
  if (result.status === "saved") return result.user;
  if (result.status === "not_found") throw notFound("User", userId ?? "");
  if (result.status === "last_instance_admin") {
    throw new ScimRequestError(409, LAST_INSTANCE_ADMIN_DETAIL, "mutability");
  }
  throw uniquenessConflict("A user with this userName or email address already exists.");
}

function unwrapSavedGroup(
  result: SaveCompanyGroupResult | ModifyCompanyGroupResult,
  companyGroupId?: string,
) {
  if (result.status === "saved") return result.companyGroup;
  if (result.status === "not_found") throw notFound("Group", companyGroupId ?? "");
  if (result.status === "unknown_member") {
    throw invalidValue(`The member ${result.userId} is not a user from the directory.`);
  }
  throw uniquenessConflict("A Company group with this displayName already exists.");
}

const SERVICE_PROVIDER_CONFIG = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://datatracker.ietf.org/doc/html/rfc7644",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: MAXIMUM_PAGE_SIZE },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{
    type: "oauthbearertoken",
    name: "Directory token",
    description: "A token that an Instance admin creates on the Access page.",
  }],
  meta: { resourceType: "ServiceProviderConfig" },
};

const RESOURCE_TYPES = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: SCIM_USER_SCHEMA,
    meta: { resourceType: "ResourceType" },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: SCIM_GROUP_SCHEMA,
    meta: { resourceType: "ResourceType" },
  },
];

function describeStringAttribute(name: string, isRequired = false) {
  return {
    name,
    type: "string",
    multiValued: false,
    required: isRequired,
    caseExact: false,
    mutability: "readWrite",
    returned: "default",
    uniqueness: "none",
  };
}

const SCHEMAS = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: SCIM_USER_SCHEMA,
    name: "User",
    attributes: [
      describeStringAttribute("userName", true),
      describeStringAttribute("displayName"),
      { ...describeStringAttribute("active"), type: "boolean" },
      { ...describeStringAttribute("emails"), type: "complex", multiValued: true },
      { ...describeStringAttribute("name"), type: "complex" },
    ],
    meta: { resourceType: "Schema" },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: SCIM_GROUP_SCHEMA,
    name: "Group",
    attributes: [
      describeStringAttribute("displayName", true),
      { ...describeStringAttribute("members"), type: "complex", multiValued: true },
    ],
    meta: { resourceType: "Schema" },
  },
];

/** The SCIM 2.0 endpoints that the company's directory calls. */
export function registerScimRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: ScimRouteDependencies,
): void {
  const { scimRepository, directoryTokenRepository, readCurrentTime } = dependencies;
  app.use(
    `${SCIM_BASE_PATH}/*`,
    requireDirectoryToken(directoryTokenRepository, readCurrentTime),
  );

  app.openapi(
    getScimServiceProviderConfigRoute,
    handleScim(() => respondWithScim(SERVICE_PROVIDER_CONFIG)),
  );
  app.openapi(
    listScimResourceTypesRoute,
    handleScim(() => respondWithScim(toScimList(RESOURCE_TYPES, RESOURCE_TYPES.length, 1))),
  );
  app.openapi(
    listScimSchemasRoute,
    handleScim(() => respondWithScim(toScimList(SCHEMAS, SCHEMAS.length, 1))),
  );

  app.openapi(
    listScimUsersRoute,
    handleScim(async (context) => {
      const page = readScimPage(context.req.query("startIndex"), context.req.query("count"));
      const { totalCount, resources } = await scimRepository.listUsers(
        readUserFilter(context.req.query("filter")),
        page,
      );
      return respondWithScim(toScimList(resources.map(toScimUser), totalCount, page.startIndex));
    }),
  );

  app.openapi(
    createScimUserRoute,
    handleScim(async (context) => {
      const attributes = parseUserResource(await readBody(context));
      const user = unwrapSavedUser(await scimRepository.createUser(attributes, readCurrentTime()));
      return respondWithScim(toScimUser(user), 201);
    }),
  );

  app.openapi(
    getScimUserRoute,
    handleScim(async (context) => {
      const userId = context.req.param("resourceId")!;
      const user = await scimRepository.findUser(userId);
      if (user === null) throw notFound("User", userId);
      return respondWithScim(toScimUser(user));
    }),
  );

  app.openapi(
    replaceScimUserRoute,
    handleScim(async (context) => {
      const userId = context.req.param("resourceId")!;
      const body = await readBody(context);
      const result = await scimRepository.modifyUser(
        userId,
        (currentUser) => parseUserResource(body, currentUser),
        readCurrentTime(),
      );
      return respondWithScim(toScimUser(unwrapSavedUser(result, userId)));
    }),
  );

  app.openapi(
    patchScimUserRoute,
    handleScim(async (context) => {
      const userId = context.req.param("resourceId")!;
      const operations = parsePatchOperations(await readBody(context));
      const result = await scimRepository.modifyUser(
        userId,
        (currentUser) => applyUserPatch(currentUser, operations),
        readCurrentTime(),
      );
      return respondWithScim(toScimUser(unwrapSavedUser(result, userId)));
    }),
  );

  app.openapi(
    deleteScimUserRoute,
    handleScim(async (context) => {
      const userId = context.req.param("resourceId")!;
      const removal = await scimRepository.removeUser(userId, readCurrentTime());
      if (removal.status === "not_found") throw notFound("User", userId);
      if (removal.status === "last_instance_admin") {
        throw new ScimRequestError(409, LAST_INSTANCE_ADMIN_DETAIL, "mutability");
      }
      return new Response(null, { status: 204 });
    }),
  );

  app.openapi(
    listScimGroupsRoute,
    handleScim(async (context) => {
      const page = readScimPage(context.req.query("startIndex"), context.req.query("count"));
      const includeMembers = !/\bmembers\b/i.test(context.req.query("excludedAttributes") ?? "");
      const { totalCount, resources } = await scimRepository.listCompanyGroups(
        readGroupFilter(context.req.query("filter")),
        page,
        includeMembers,
      );
      return respondWithScim(
        toScimList(
          resources.map((resource) => toScimGroup(resource, includeMembers)),
          totalCount,
          page.startIndex,
        ),
      );
    }),
  );

  app.openapi(
    createScimGroupRoute,
    handleScim(async (context) => {
      const attributes = parseGroupResource(await readBody(context));
      const companyGroup = unwrapSavedGroup(
        await scimRepository.createCompanyGroup(attributes, readCurrentTime()),
      );
      return respondWithScim(toScimGroup(companyGroup), 201);
    }),
  );

  app.openapi(
    getScimGroupRoute,
    handleScim(async (context) => {
      const companyGroupId = context.req.param("resourceId")!;
      const companyGroup = await scimRepository.findCompanyGroup(companyGroupId);
      if (companyGroup === null) throw notFound("Group", companyGroupId);
      return respondWithScim(toScimGroup(companyGroup));
    }),
  );

  app.openapi(
    replaceScimGroupRoute,
    handleScim(async (context) => {
      const companyGroupId = context.req.param("resourceId")!;
      const body = await readBody(context);
      const result = await scimRepository.modifyCompanyGroup(
        companyGroupId,
        (currentGroup) => parseGroupResource(body, currentGroup),
        readCurrentTime(),
      );
      return respondWithScim(toScimGroup(unwrapSavedGroup(result, companyGroupId)));
    }),
  );

  app.openapi(
    patchScimGroupRoute,
    handleScim(async (context) => {
      const companyGroupId = context.req.param("resourceId")!;
      const operations = parsePatchOperations(await readBody(context));
      const result = await scimRepository.modifyCompanyGroup(
        companyGroupId,
        (currentGroup) => applyGroupPatch(currentGroup, operations),
        readCurrentTime(),
      );
      return respondWithScim(toScimGroup(unwrapSavedGroup(result, companyGroupId)));
    }),
  );

  app.openapi(
    deleteScimGroupRoute,
    handleScim(async (context) => {
      const companyGroupId = context.req.param("resourceId")!;
      if (!await scimRepository.removeCompanyGroup(companyGroupId, readCurrentTime())) {
        throw notFound("Group", companyGroupId);
      }
      return new Response(null, { status: 204 });
    }),
  );
}
