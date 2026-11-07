import type {
  CreatePromptRequest,
  CreatePromptVersionRequest,
  ListPromptsResponse,
  ListPromptVersionsResponse,
  PromptLabel,
  PromptSummary,
  PromptVersion,
  PromptVersionComparison,
} from "@extispex/contracts";
import { requestJson } from "./api-request.ts";

function promptPath(promptName: string): string {
  return `/v1/prompts/${encodeURIComponent(promptName)}`;
}

export function listPrompts(apiKey: string): Promise<ListPromptsResponse> {
  return requestJson(apiKey, "/v1/prompts");
}

export function getPrompt(apiKey: string, promptName: string): Promise<PromptSummary> {
  return requestJson(apiKey, promptPath(promptName));
}

export function createPrompt(apiKey: string, request: CreatePromptRequest): Promise<PromptVersion> {
  return requestJson(apiKey, "/v1/prompts", { method: "POST", body: request });
}

export function createPromptVersion(
  apiKey: string,
  promptName: string,
  request: CreatePromptVersionRequest,
): Promise<PromptVersion> {
  return requestJson(apiKey, `${promptPath(promptName)}/versions`, {
    method: "POST",
    body: request,
  });
}

export function listPromptVersions(
  apiKey: string,
  promptName: string,
): Promise<ListPromptVersionsResponse> {
  return requestJson(apiKey, `${promptPath(promptName)}/versions`);
}

export function getPromptVersion(
  apiKey: string,
  promptName: string,
  versionNumber: number,
): Promise<PromptVersion> {
  return requestJson(apiKey, `${promptPath(promptName)}/versions/${versionNumber}`);
}

export function movePromptLabel(
  apiKey: string,
  promptName: string,
  labelName: string,
  versionNumber: number,
): Promise<PromptLabel> {
  return requestJson(apiKey, `${promptPath(promptName)}/labels/${encodeURIComponent(labelName)}`, {
    method: "PUT",
    body: { versionNumber },
  });
}

export function removePromptLabel(
  apiKey: string,
  promptName: string,
  labelName: string,
): Promise<null> {
  return requestJson(apiKey, `${promptPath(promptName)}/labels/${encodeURIComponent(labelName)}`, {
    method: "DELETE",
  });
}

export function comparePromptVersions(
  apiKey: string,
  promptName: string,
  fromVersion: number,
  toVersion: number,
): Promise<PromptVersionComparison> {
  const searchParameters = new URLSearchParams({
    fromVersion: String(fromVersion),
    toVersion: String(toVersion),
  });
  return requestJson(apiKey, `${promptPath(promptName)}/compare?${searchParameters}`);
}
