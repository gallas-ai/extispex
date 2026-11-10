import {
  createErrorResponse,
  createTargetRoute,
  deleteTargetRoute,
  getTargetRoute,
  listTargetsRoute,
  updateTargetRoute,
} from "@extispex/contracts";
import type { ProjectAccessEnvironment } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TargetRepository } from "../storage/target-repository.ts";

export interface TargetRouteDependencies {
  targetRepository: TargetRepository;
  readCurrentTime: () => Date;
}

function targetNotFoundError(targetName: string) {
  return createErrorResponse("not_found", `Target ${targetName} was not found.`);
}

export function registerTargetRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  { targetRepository, readCurrentTime }: TargetRouteDependencies,
): void {
  app.openapi(createTargetRoute, async (context) => {
    const request = context.req.valid("json");
    const creation = await targetRepository.createTarget(
      context.get("projectAccess").projectId,
      {
        name: request.name,
        url: request.url,
        description: request.description?.trim() ?? "",
        credential: request.credential ?? null,
      },
      readCurrentTime(),
    );
    if (creation.status === "name_taken") {
      return context.json(
        createErrorResponse("conflict", `A Target named ${request.name} already exists.`),
        409,
      );
    }
    return context.json(creation.created, 201);
  });

  app.openapi(listTargetsRoute, async (context) => {
    const targets = await targetRepository.listTargets(context.get("projectAccess").projectId);
    return context.json({ targets }, 200);
  });

  app.openapi(getTargetRoute, async (context) => {
    const { targetName } = context.req.valid("param");
    const target = await targetRepository.readTarget(
      context.get("projectAccess").projectId,
      targetName,
    );
    if (target === null) return context.json(targetNotFoundError(targetName), 404);
    return context.json(target, 200);
  });

  app.openapi(updateTargetRoute, async (context) => {
    const { targetName } = context.req.valid("param");
    const request = context.req.valid("json");
    const target = await targetRepository.updateTarget(
      context.get("projectAccess").projectId,
      targetName,
      {
        url: request.url,
        description: request.description?.trim() ?? "",
        credential: request.credential,
      },
      readCurrentTime(),
    );
    if (target === null) return context.json(targetNotFoundError(targetName), 404);
    return context.json(target, 200);
  });

  app.openapi(deleteTargetRoute, async (context) => {
    const { targetName } = context.req.valid("param");
    const wasDeleted = await targetRepository.deleteTarget(
      context.get("projectAccess").projectId,
      targetName,
    );
    if (!wasDeleted) return context.json(targetNotFoundError(targetName), 404);
    return context.body(null, 204);
  });
}
