import { getPromptVersionRoute, type PromptVersion } from "@extispex/contracts";
import type { ServiceClient } from "@extispex/service-client";
import { createServiceTokenClient, type ServiceTokenSource } from "@extispex/service-runtime";

export type PromptVersionLookup =
  | { status: "found"; promptVersion: PromptVersion }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

/** Reads the Prompt Versions that Grading Evaluators and LLM Summaries use. */
export interface PromptClient {
  readPromptVersion(
    projectId: string,
    promptName: string,
    versionNumber: number,
  ): Promise<PromptVersionLookup>;
}

/** Reads through the Prompt service's public API, with a service token for the Project. */
export function createPromptClient(
  promptService: ServiceClient,
  serviceTokens: ServiceTokenSource,
): PromptClient {
  return {
    async readPromptVersion(projectId, promptName, versionNumber) {
      const path = getPromptVersionRoute.path
        .replace("{promptName}", encodeURIComponent(promptName))
        .replace("{versionNumber}", String(versionNumber));
      let response: Response;
      try {
        const projectClient = createServiceTokenClient(promptService, serviceTokens, projectId);
        response = await projectClient(new Request(`http://prompt${path}`));
      } catch (error) {
        return {
          status: "unavailable",
          reason: `The Prompt service could not be reached: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return { status: "not_found" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return {
          status: "unavailable",
          reason: `The Prompt service answered with status ${response.status}.`,
        };
      }
      return { status: "found", promptVersion: await response.json() as PromptVersion };
    },
  };
}
