import {
  createErrorResponse,
  createLlmProviderRoute,
  DEFAULT_LLM_PROVIDER_BASE_URLS,
  deleteLlmProviderRoute,
  getLlmProviderRoute,
  getLlmSummarySettingsRoute,
  listLlmProvidersRoute,
  updateLlmProviderRoute,
  updateLlmSummarySettingsRoute,
} from "@extispex/contracts";
import type { ProjectAccessEnvironment } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { LlmProviderRepository } from "../storage/mod.ts";

export interface LlmProviderRouteDependencies {
  llmProviderRepository: LlmProviderRepository;
  readCurrentTime: () => Date;
}

function providerNotFoundError(providerName: string) {
  return createErrorResponse("not_found", `LLM provider ${providerName} was not found.`);
}

export function registerLlmProviderRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  { llmProviderRepository, readCurrentTime }: LlmProviderRouteDependencies,
): void {
  app.openapi(createLlmProviderRoute, async (context) => {
    const request = context.req.valid("json");
    const creation = await llmProviderRepository.createProvider(
      context.get("projectAccess").projectId,
      {
        name: request.name,
        kind: request.kind,
        baseUrl: request.baseUrl ?? DEFAULT_LLM_PROVIDER_BASE_URLS[request.kind],
        defaultModel: request.defaultModel.trim(),
        description: request.description?.trim() ?? "",
        apiKey: request.apiKey ?? null,
      },
      readCurrentTime(),
    );
    if (creation.status === "name_taken") {
      return context.json(
        createErrorResponse("conflict", `An LLM provider named ${request.name} already exists.`),
        409,
      );
    }
    return context.json(creation.created, 201);
  });

  app.openapi(listLlmProvidersRoute, async (context) => {
    const llmProviders = await llmProviderRepository.listProviders(
      context.get("projectAccess").projectId,
    );
    return context.json({ llmProviders }, 200);
  });

  app.openapi(getLlmProviderRoute, async (context) => {
    const { providerName } = context.req.valid("param");
    const provider = await llmProviderRepository.readProvider(
      context.get("projectAccess").projectId,
      providerName,
    );
    if (provider === null) return context.json(providerNotFoundError(providerName), 404);
    return context.json(provider, 200);
  });

  app.openapi(updateLlmProviderRoute, async (context) => {
    const { providerName } = context.req.valid("param");
    const request = context.req.valid("json");
    const update = await llmProviderRepository.updateProvider(
      context.get("projectAccess").projectId,
      providerName,
      {
        baseUrl: request.baseUrl,
        defaultModel: request.defaultModel.trim(),
        description: request.description?.trim() ?? "",
        apiKey: request.apiKey,
      },
      readCurrentTime(),
    );
    if (update.status === "not_found") {
      return context.json(providerNotFoundError(providerName), 404);
    }
    if (update.status === "api_key_required") {
      return context.json(
        createErrorResponse("invalid_request", "This kind of provider needs an API key."),
        400,
      );
    }
    return context.json(update.updated, 200);
  });

  app.openapi(deleteLlmProviderRoute, async (context) => {
    const { providerName } = context.req.valid("param");
    const wasDeleted = await llmProviderRepository.deleteProvider(
      context.get("projectAccess").projectId,
      providerName,
    );
    if (!wasDeleted) return context.json(providerNotFoundError(providerName), 404);
    return context.body(null, 204);
  });

  app.openapi(getLlmSummarySettingsRoute, async (context) => {
    return context.json(
      await llmProviderRepository.readSummarySettings(context.get("projectAccess").projectId),
      200,
    );
  });

  app.openapi(updateLlmSummarySettingsRoute, async (context) => {
    const request = context.req.valid("json");
    const update = await llmProviderRepository.updateSummarySettings(
      context.get("projectAccess").projectId,
      { providerName: request.providerName, prompt: request.prompt },
      readCurrentTime(),
    );
    if (update.status === "unknown_provider") {
      return context.json(
        createErrorResponse(
          "invalid_request",
          `LLM provider ${request.providerName} was not found.`,
        ),
        400,
      );
    }
    if (update.status === "no_text_generation") {
      return context.json(
        createErrorResponse(
          "invalid_request",
          `LLM provider ${request.providerName} cannot write text, which an LLM Summary needs.`,
        ),
        400,
      );
    }
    return context.json(update.settings, 200);
  });
}
