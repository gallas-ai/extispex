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
import { type ApiCredentials, requestJson } from "./api-request.ts";

function promptPath(promptName: string): string {
  return `/v1/prompts/${encodeURIComponent(promptName)}`;
}

export function listPrompts(credentials: ApiCredentials): Promise<ListPromptsResponse> {
  return requestJson(credentials, "/v1/prompts");
}

export function getPrompt(credentials: ApiCredentials, promptName: string): Promise<PromptSummary> {
  return requestJson(credentials, promptPath(promptName));
}

export function createPrompt(
  credentials: ApiCredentials,
  request: CreatePromptRequest,
): Promise<PromptVersion> {
  return requestJson(credentials, "/v1/prompts", { method: "POST", body: request });
}

export function createPromptVersion(
  credentials: ApiCredentials,
  promptName: string,
  request: CreatePromptVersionRequest,
): Promise<PromptVersion> {
  return requestJson(credentials, `${promptPath(promptName)}/versions`, {
    method: "POST",
    body: request,
  });
}

export function listPromptVersions(
  credentials: ApiCredentials,
  promptName: string,
): Promise<ListPromptVersionsResponse> {
  return requestJson(credentials, `${promptPath(promptName)}/versions`);
}

export function getPromptVersion(
  credentials: ApiCredentials,
  promptName: string,
  versionNumber: number,
): Promise<PromptVersion> {
  return requestJson(credentials, `${promptPath(promptName)}/versions/${versionNumber}`);
}

export function movePromptLabel(
  credentials: ApiCredentials,
  promptName: string,
  labelName: string,
  versionNumber: number,
): Promise<PromptLabel> {
  return requestJson(
    credentials,
    `${promptPath(promptName)}/labels/${encodeURIComponent(labelName)}`,
    {
      method: "PUT",
      body: { versionNumber },
    },
  );
}

export function removePromptLabel(
  credentials: ApiCredentials,
  promptName: string,
  labelName: string,
): Promise<null> {
  return requestJson(
    credentials,
    `${promptPath(promptName)}/labels/${encodeURIComponent(labelName)}`,
    {
      method: "DELETE",
    },
  );
}

export function comparePromptVersions(
  credentials: ApiCredentials,
  promptName: string,
  fromVersion: number,
  toVersion: number,
): Promise<PromptVersionComparison> {
  const searchParameters = new URLSearchParams({
    fromVersion: String(fromVersion),
    toVersion: String(toVersion),
  });
  return requestJson(credentials, `${promptPath(promptName)}/compare?${searchParameters}`);
}
