import { parseKeyValueList } from "./environment-variables.ts";

/** Finds the Project that an API key belongs to. */
export interface ProjectResolver {
  resolveProjectId(apiKey: string): Promise<string | null>;
}

/**
 * Temporary resolver backed by a fixed list of API keys, used until the Identity service exists.
 * The list has the form `first-api-key=first-project-id,second-api-key=second-project-id`.
 */
export function createStaticApiKeyProjectResolver(apiKeyList: string): ProjectResolver {
  const projectIdsByApiKey = parseKeyValueList(apiKeyList, "STATIC_API_KEYS");
  return {
    resolveProjectId: (apiKey) => Promise.resolve(projectIdsByApiKey.get(apiKey) ?? null),
  };
}

/** Returns the bearer token from an `Authorization` header value, or null. */
export function extractBearerToken(authorizationHeader: string | null | undefined): string | null {
  const bearerMatch = authorizationHeader?.match(/^Bearer\s+(\S+)$/i);
  return bearerMatch ? bearerMatch[1] : null;
}

export async function authenticateProject(
  projectResolver: ProjectResolver,
  authorizationHeader: string | null | undefined,
): Promise<string | null> {
  const apiKey = extractBearerToken(authorizationHeader);
  return apiKey === null ? null : await projectResolver.resolveProjectId(apiKey);
}
