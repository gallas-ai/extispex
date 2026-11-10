import {
  createDirectoryTokenRoute,
  createErrorResponse,
  type DirectoryImportFormat,
  type DirectoryImportProblem,
  type DirectoryImportUser,
  getDirectoryStatusRoute,
  importDirectoryRoute,
  revokeDirectoryTokenRoute,
} from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { generateApiKey, hashRandomSecret, readKeyPrefix } from "../api-keys/api-key-secrets.ts";
import {
  type IdentityEnvironment,
  INSTANCE_ADMIN_REQUIRED,
} from "../access/user-authentication.ts";
import type {
  DirectoryImportRepository,
  DirectoryImportRow,
} from "../storage/directory-import-repository.ts";
import type { DirectoryTokenRepository } from "../storage/directory-token-repository.ts";
import { numberJsonRows, parseDirectoryCsv } from "./directory-import-parser.ts";

export interface DirectoryRouteDependencies {
  directoryTokenRepository: DirectoryTokenRepository;
  directoryImportRepository: DirectoryImportRepository;
  readCurrentTime: () => Date;
}

function createImportFailure(problems: DirectoryImportProblem[]) {
  return {
    ...createErrorResponse("invalid_import", "The file was not applied. Fix the rows it lists."),
    problems,
  };
}

/** Tokens for the company's directory, imported files and the state of the sync. */
export function registerDirectoryRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  dependencies: DirectoryRouteDependencies,
): void {
  const { directoryTokenRepository, directoryImportRepository, readCurrentTime } = dependencies;

  app.openapi(getDirectoryStatusRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const [tokens, overview] = await Promise.all([
      directoryTokenRepository.listTokens(),
      directoryImportRepository.readOverview(),
    ]);
    const lastScimRequestAt = tokens.map((token) => token.lastUsedAt)
      .filter((lastUsedAt) => lastUsedAt !== null).sort().at(-1) ?? null;
    return context.json({ tokens, lastScimRequestAt, ...overview }, 200);
  });

  app.openapi(createDirectoryTokenRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const token = generateApiKey();
    const directoryToken = await directoryTokenRepository.createToken({
      name: context.req.valid("json").name,
      tokenPrefix: readKeyPrefix(token),
      tokenHash: await hashRandomSecret(token),
    }, readCurrentTime());
    return context.json({ ...directoryToken, token }, 201);
  });

  app.openapi(revokeDirectoryTokenRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { tokenId } = context.req.valid("param");
    if (!await directoryTokenRepository.revokeToken(tokenId, readCurrentTime())) {
      return context.json(
        createErrorResponse("not_found", `Directory token ${tokenId} was not found.`),
        404,
      );
    }
    return context.body(null, 204);
  });

  app.openapi(importDirectoryRoute, async (context) => {
    const currentUser = context.get("currentUser");
    if (!currentUser.isInstanceAdmin) return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    let rows: DirectoryImportRow[];
    let format: DirectoryImportFormat;
    if ((context.req.header("content-type") ?? "").toLowerCase().startsWith("text/csv")) {
      const parsedFile = parseDirectoryCsv(await context.req.text());
      if (parsedFile.status === "invalid") {
        return context.json(createImportFailure(parsedFile.problems), 400);
      }
      rows = parsedFile.rows;
      format = "csv";
    } else {
      // A body that is not JSON reaches here unvalidated, as an empty object or as text.
      const jsonBody = context.req.valid("json") as unknown;
      const users = typeof jsonBody === "object" && jsonBody !== null
        ? (jsonBody as { users?: DirectoryImportUser[] }).users
        : undefined;
      if (users === undefined) {
        return context.json(
          createImportFailure([{ row: 0, message: "Send application/json or text/csv." }]),
          400,
        );
      }
      rows = numberJsonRows(users);
      format = "json";
    }
    const result = await directoryImportRepository.importUsers(
      rows,
      format,
      currentUser.id,
      readCurrentTime(),
    );
    if (result.status === "rejected") {
      return context.json(createImportFailure(result.problems), 400);
    }
    return context.json(result.summary, 200);
  }, (validationResult, context) => {
    if (validationResult.success) return;
    return context.json(
      createImportFailure(validationResult.error.issues.map((issue) => {
        const [collection, userIndex, ...fieldPath] = issue.path;
        return collection === "users" && typeof userIndex === "number"
          ? {
            row: userIndex + 1,
            message: `${fieldPath.join(".") || "row"}: ${issue.message}`,
          }
          : { row: 0, message: `${issue.path.join(".") || "request"}: ${issue.message}` };
      })),
      400,
    );
  });
}
