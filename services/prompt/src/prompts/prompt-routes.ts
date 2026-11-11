import {
  comparePromptVersionsRoute,
  createErrorResponse,
  createPromptRoute,
  createPromptVersionRoute,
  getPromptRoute,
  getPromptVersionByLabelRoute,
  getPromptVersionRoute,
  listPromptsRoute,
  listPromptVersionsRoute,
  movePromptLabelRoute,
  removePromptLabelRoute,
} from "@extispex/contracts";
import {
  type ProjectAccessEnvironment,
  type RequestAuthenticator,
  requireProjectAccess,
} from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { PromptRepository } from "../storage/mod.ts";
import { comparePromptVersions } from "./prompt-version-comparison.ts";
import { createNewPromptVersion } from "./prompt-versions.ts";

/** Hono context variables set by the authentication middleware. */
export type PromptServiceEnvironment = ProjectAccessEnvironment;

export interface PromptRouteDependencies {
  promptRepository: PromptRepository;
  requestAuthenticator: RequestAuthenticator;
  readCurrentTime: () => Date;
}

function promptNotFoundError(promptName: string) {
  return createErrorResponse("not_found", `Prompt ${promptName} was not found.`);
}

function versionNotFoundError(promptName: string, versionNumber: number) {
  return createErrorResponse(
    "not_found",
    `Prompt ${promptName} has no version ${versionNumber}.`,
  );
}

function labelNotFoundError(promptName: string, labelName: string) {
  return createErrorResponse("not_found", `Prompt ${promptName} has no label ${labelName}.`);
}

export function registerPromptRoutes(
  app: OpenAPIHono<PromptServiceEnvironment>,
  dependencies: PromptRouteDependencies,
): void {
  const { promptRepository } = dependencies;

  // Reading takes the Role viewer, and every change editor.
  app.use("/v1/*", requireProjectAccess(dependencies.requestAuthenticator));

  app.openapi(createPromptRoute, async (context) => {
    const request = context.req.valid("json");
    const creation = await promptRepository.createPrompt(
      context.get("projectAccess").projectId,
      { name: request.name, description: request.description?.trim() ?? "" },
      createNewPromptVersion(request),
      dependencies.readCurrentTime(),
    );
    if (creation.status === "name_taken") {
      return context.json(
        createErrorResponse("conflict", `A prompt named ${request.name} already exists.`),
        409,
      );
    }
    return context.json(creation.version, 201);
  });

  app.openapi(listPromptsRoute, async (context) => {
    const prompts = await promptRepository.listPrompts(context.get("projectAccess").projectId);
    return context.json({ prompts }, 200);
  });

  app.openapi(getPromptRoute, async (context) => {
    const { promptName } = context.req.valid("param");
    const prompt = await promptRepository.findPrompt(
      context.get("projectAccess").projectId,
      promptName,
    );
    if (prompt === null) return context.json(promptNotFoundError(promptName), 404);
    return context.json(await promptRepository.readPromptSummary(prompt), 200);
  });

  app.openapi(createPromptVersionRoute, async (context) => {
    const { promptName } = context.req.valid("param");
    const prompt = await promptRepository.findPrompt(
      context.get("projectAccess").projectId,
      promptName,
    );
    if (prompt === null) return context.json(promptNotFoundError(promptName), 404);
    const version = await promptRepository.addVersion(
      prompt,
      createNewPromptVersion(context.req.valid("json")),
      dependencies.readCurrentTime(),
    );
    return context.json(version, 201);
  });

  app.openapi(listPromptVersionsRoute, async (context) => {
    const { promptName } = context.req.valid("param");
    const prompt = await promptRepository.findPrompt(
      context.get("projectAccess").projectId,
      promptName,
    );
    if (prompt === null) return context.json(promptNotFoundError(promptName), 404);
    return context.json({ versions: await promptRepository.listVersions(prompt) }, 200);
  });

  app.openapi(getPromptVersionRoute, async (context) => {
    const { promptName, versionNumber } = context.req.valid("param");
    const prompt = await promptRepository.findPrompt(
      context.get("projectAccess").projectId,
      promptName,
    );
    if (prompt === null) return context.json(promptNotFoundError(promptName), 404);
    const version = await promptRepository.findVersion(prompt, versionNumber);
    if (version === null) {
      return context.json(versionNotFoundError(promptName, versionNumber), 404);
    }
    return context.json(version, 200);
  });

  app.openapi(getPromptVersionByLabelRoute, async (context) => {
    const { promptName, labelName } = context.req.valid("param");
    const prompt = await promptRepository.findPrompt(
      context.get("projectAccess").projectId,
      promptName,
    );
    if (prompt === null) return context.json(promptNotFoundError(promptName), 404);
    const version = await promptRepository.findVersionByLabel(prompt, labelName);
    if (version === null) return context.json(labelNotFoundError(promptName, labelName), 404);
    return context.json(version, 200);
  });

  app.openapi(movePromptLabelRoute, async (context) => {
    const { promptName, labelName } = context.req.valid("param");
    const { versionNumber } = context.req.valid("json");
    const prompt = await promptRepository.findPrompt(
      context.get("projectAccess").projectId,
      promptName,
    );
    if (prompt === null) return context.json(promptNotFoundError(promptName), 404);
    const label = await promptRepository.moveLabel(
      prompt,
      labelName,
      versionNumber,
      dependencies.readCurrentTime(),
    );
    if (label === null) {
      return context.json(versionNotFoundError(promptName, versionNumber), 404);
    }
    return context.json(label, 200);
  });

  app.openapi(removePromptLabelRoute, async (context) => {
    const { promptName, labelName } = context.req.valid("param");
    const prompt = await promptRepository.findPrompt(
      context.get("projectAccess").projectId,
      promptName,
    );
    if (prompt === null) return context.json(promptNotFoundError(promptName), 404);
    if (!await promptRepository.removeLabel(prompt, labelName)) {
      return context.json(labelNotFoundError(promptName, labelName), 404);
    }
    return context.body(null, 204);
  });

  app.openapi(comparePromptVersionsRoute, async (context) => {
    const { promptName } = context.req.valid("param");
    const { fromVersion: fromVersionNumber, toVersion: toVersionNumber } = context.req.valid(
      "query",
    );
    const prompt = await promptRepository.findPrompt(
      context.get("projectAccess").projectId,
      promptName,
    );
    if (prompt === null) return context.json(promptNotFoundError(promptName), 404);
    const [fromVersion, toVersion] = await Promise.all([
      promptRepository.findVersion(prompt, fromVersionNumber),
      promptRepository.findVersion(prompt, toVersionNumber),
    ]);
    if (fromVersion === null) {
      return context.json(versionNotFoundError(promptName, fromVersionNumber), 404);
    }
    if (toVersion === null) {
      return context.json(versionNotFoundError(promptName, toVersionNumber), 404);
    }
    return context.json(comparePromptVersions(fromVersion, toVersion), 200);
  });
}
