/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import type { PromptVersion } from "@extispex/contracts";
import {
  checkDraft,
  createDraftFromVersion,
  createEmptyDraft,
  findDraftVariables,
} from "./prompt-draft.ts";

Deno.test("a filled-in draft becomes a version request with typed parameters", () => {
  const draft = {
    ...createEmptyDraft(),
    messages: [
      { role: "system" as const, content: "You help {{company}}." },
      { role: "user" as const, content: "{{question}}" },
    ],
    model: " gpt-4.1 ",
    temperature: "0.2",
    maxOutputTokens: "",
    providerOptionsJson: '{"reasoning_effort": "low"}',
    commitMessage: "First draft",
    labelNames: "staging, production staging",
  };
  assertEquals(checkDraft(draft), {
    isValid: true,
    request: {
      type: "chat",
      messages: draft.messages,
      modelParameters: {
        model: "gpt-4.1",
        temperature: 0.2,
        providerOptions: { reasoning_effort: "low" },
      },
      commitMessage: "First draft",
      labels: ["staging", "production"],
    },
  });
  assertEquals(findDraftVariables(draft), ["company", "question"]);
});

Deno.test("the draft explains what the form can check itself", () => {
  const emptyDraft = createEmptyDraft();
  assertEquals(checkDraft(emptyDraft), { isValid: false, problem: "Message 1 is empty." });
  assertEquals(
    checkDraft({ ...emptyDraft, type: "text", text: "Hi", temperature: "warm" }),
    { isValid: false, problem: "Temperature must be a number." },
  );
  assertEquals(
    checkDraft({ ...emptyDraft, type: "text", text: "Hi", providerOptionsJson: "[1]" }),
    { isValid: false, problem: "Provider options must be a JSON object." },
  );
});

Deno.test("a draft from an existing version keeps its content but not its labels", () => {
  const version: PromptVersion = {
    type: "text",
    promptName: "run-summary",
    versionNumber: 3,
    text: "Summarize {{run}}.",
    modelParameters: {
      model: "gpt-4.1",
      temperature: 0,
      maxOutputTokens: null,
      topP: null,
      providerOptions: {},
    },
    variables: ["run"],
    commitMessage: "Shorter",
    labels: ["production"],
    createdAt: "2026-11-07T10:00:00.000Z",
  };
  const draft = createDraftFromVersion(version);
  assertEquals(
    [draft.type, draft.text, draft.model, draft.temperature, draft.labelNames, draft.commitMessage],
    ["text", "Summarize {{run}}.", "gpt-4.1", "0", "", ""],
  );
});
