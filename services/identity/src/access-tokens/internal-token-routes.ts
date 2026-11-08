import {
  createErrorResponse,
  getPublicKeySetRoute,
  issueServiceTokenRoute,
  resolveApiKeyRoute,
  SERVICE_SUBJECT_PREFIX,
} from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { authenticateService, type IdentityEnvironment } from "../access/user-authentication.ts";
import { areSecretsEqual, hashApiKey } from "../api-keys/api-key-secrets.ts";
import type { ProjectRepository } from "../storage/project-repository.ts";
import type { AccessTokenSigner } from "./signing-keys.ts";

export interface InternalTokenRouteDependencies {
  projectRepository: ProjectRepository;
  accessTokenSigner: AccessTokenSigner;
  /** Each service's client secret by client ID, from `SERVICE_CLIENTS`. */
  serviceClientSecrets: ReadonlyMap<string, string>;
}

/**
 * The internal endpoints other services call: Identity's public keys, service tokens, and the
 * resolution of API keys. The Gateway forwards none of them.
 */
export function registerInternalTokenRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: InternalTokenRouteDependencies,
): void {
  const { projectRepository, accessTokenSigner } = dependencies;

  app.openapi(getPublicKeySetRoute, async (context) => {
    return context.json(await accessTokenSigner.readPublicKeySet(), 200);
  });

  app.openapi(issueServiceTokenRoute, async (context) => {
    const clientId = await authenticateServiceClient(
      context.req.header("authorization"),
      dependencies.serviceClientSecrets,
    );
    if (clientId === null) {
      return context.json(
        createErrorResponse(
          "unauthenticated",
          "A service's client ID and secret are required as HTTP Basic authentication.",
        ),
        401,
      );
    }
    const { projectId } = context.req.valid("json");
    if (projectId !== undefined && await projectRepository.findProject(projectId) === null) {
      return context.json(
        createErrorResponse("not_found", `Project ${projectId} was not found.`),
        404,
      );
    }
    // A service reads another service's data for the Project it works on, and changes nothing.
    const projectAccess = projectId === undefined ? null : { projectId, role: "viewer" as const };
    const { accessToken, expiresAt } = await accessTokenSigner.issueAccessToken(
      `${SERVICE_SUBJECT_PREFIX}${clientId}`,
      projectAccess,
    );
    return context.json({
      accessToken,
      expiresAt: expiresAt.toISOString(),
      projectId: projectId ?? null,
      role: projectAccess?.role ?? null,
    }, 200);
  });

  app.openapi(resolveApiKeyRoute, async (context) => {
    if (
      await authenticateService(accessTokenSigner, context.req.header("authorization")) === null
    ) {
      return context.json(
        createErrorResponse("unauthenticated", "A service token is required."),
        401,
      );
    }
    const { apiKey } = context.req.valid("json");
    const projectId = await projectRepository.findProjectIdByKeyHash(await hashApiKey(apiKey));
    if (projectId === null) {
      return context.json(createErrorResponse("not_found", "The API key does not work."), 404);
    }
    return context.json({ projectId }, 200);
  });
}

/** The client ID whose secret the Basic `Authorization` header carries, or null. */
async function authenticateServiceClient(
  authorizationHeader: string | undefined,
  serviceClientSecrets: ReadonlyMap<string, string>,
): Promise<string | null> {
  const basicMatch = authorizationHeader?.match(/^Basic\s+(\S+)$/i);
  if (!basicMatch) return null;
  let credentials: string;
  try {
    credentials = atob(basicMatch[1]);
  } catch {
    return null;
  }
  const separatorIndex = credentials.indexOf(":");
  if (separatorIndex < 0) return null;
  const clientId = credentials.slice(0, separatorIndex);
  const expectedSecret = serviceClientSecrets.get(clientId);
  if (expectedSecret === undefined) return null;
  return await areSecretsEqual(credentials.slice(separatorIndex + 1), expectedSecret)
    ? clientId
    : null;
}
