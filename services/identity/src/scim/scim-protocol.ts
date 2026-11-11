/** The parts of SCIM 2.0 (RFC 7643 and 7644) that every endpoint shares. */

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const SCIM_CONTENT_TYPE = "application/scim+json";

/** A request that SCIM's own error format must answer. */
export class ScimRequestError extends Error {
  override name = "ScimRequestError";
  constructor(readonly status: number, readonly detail: string, readonly scimType?: string) {
    super(detail);
  }
}

export function respondWithScim(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", SCIM_CONTENT_TYPE);
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function respondWithScimError(error: ScimRequestError, headers?: HeadersInit): Response {
  return respondWithScim(
    {
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(error.status),
      ...(error.scimType === undefined ? {} : { scimType: error.scimType }),
      detail: error.detail,
    },
    error.status,
    headers,
  );
}

export function invalidValue(detail: string): ScimRequestError {
  return new ScimRequestError(400, detail, "invalidValue");
}

export function invalidSyntax(detail: string): ScimRequestError {
  return new ScimRequestError(400, detail, "invalidSyntax");
}

export function notFound(resourceName: string, resourceId: string): ScimRequestError {
  return new ScimRequestError(404, `${resourceName} ${resourceId} was not found.`);
}

export function uniquenessConflict(detail: string): ScimRequestError {
  return new ScimRequestError(409, detail, "uniqueness");
}

/** Microsoft Entra sends booleans as `"True"` and `"False"` in PATCH requests. */
export function readScimBoolean(value: unknown, attributeName: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  throw invalidValue(`${attributeName} must be true or false.`);
}

export interface EqualityFilter {
  /** Lowercase, because SCIM attribute names are case-insensitive. */
  attributeName: string;
  value: string;
}

const EQUALITY_FILTER = /^\s*([A-Za-z.]+)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i;

/** Parses `userName eq "ada@example.com"`, the only filter this Instance needs to offer. */
export function parseEqualityFilter(filter: string | undefined): EqualityFilter | null {
  if (filter === undefined || filter.trim() === "") return null;
  const match = EQUALITY_FILTER.exec(filter);
  if (match === null) {
    throw new ScimRequestError(400, `The filter ${filter} is not supported.`, "invalidFilter");
  }
  let value: unknown;
  try {
    value = JSON.parse(match[2]);
  } catch {
    throw new ScimRequestError(400, `The filter ${filter} is malformed.`, "invalidFilter");
  }
  return { attributeName: match[1].toLowerCase(), value: value as string };
}

const DEFAULT_PAGE_SIZE = 100;
export const MAXIMUM_PAGE_SIZE = 200;

export interface ScimPage {
  startIndex: number;
  offset: number;
  limit: number;
}

/** SCIM counts from 1 and treats values out of range as the nearest valid one. */
export function readScimPage(startIndexText?: string, countText?: string): ScimPage {
  const startIndex = Math.max(Math.trunc(Number(startIndexText ?? 1)) || 1, 1);
  const parsedCount = Math.trunc(Number(countText ?? DEFAULT_PAGE_SIZE));
  const limit = Number.isNaN(parsedCount)
    ? DEFAULT_PAGE_SIZE
    : Math.min(Math.max(parsedCount, 0), MAXIMUM_PAGE_SIZE);
  return { startIndex, offset: startIndex - 1, limit };
}

export function toScimList(
  resources: unknown[],
  totalCount: number,
  startIndex: number,
): Record<string, unknown> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: totalCount,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}
