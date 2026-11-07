import { assertEquals } from "@std/assert";
import type { PromptMessage, PromptVersion } from "@extispex/contracts";
import { comparePromptVersions } from "../src/prompts/prompt-version-comparison.ts";

const NO_MODEL_PARAMETERS = {
  model: null,
  temperature: null,
  maxOutputTokens: null,
  topP: null,
  providerOptions: {},
};

function chatVersion(versionNumber: number, messages: PromptMessage[]): PromptVersion {
  return {
    type: "chat",
    promptName: "support-agent",
    versionNumber,
    messages,
    modelParameters: NO_MODEL_PARAMETERS,
    variables: [],
    commitMessage: null,
    labels: [],
    createdAt: "2026-11-07T10:00:00.000Z",
  };
}

function textVersion(versionNumber: number, text: string): PromptVersion {
  return { ...chatVersion(versionNumber, []), type: "text", text } as PromptVersion;
}

function summarize(fromVersion: PromptVersion, toVersion: PromptVersion) {
  return comparePromptVersions(fromVersion, toVersion).contentChanges.map((contentChange) => [
    contentChange.change,
    contentChange.fromRole,
    contentChange.toRole,
    contentChange.lines.map((line) => `${line.change[0]} ${line.text}`).join(" | "),
  ]);
}

Deno.test("an inserted message leaves the following messages unchanged", () => {
  const before = chatVersion(1, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "{{question}}" },
  ]);
  const after = chatVersion(2, [
    { role: "system", content: "Be brief." },
    { role: "assistant", content: "Example answer." },
    { role: "user", content: "{{question}}" },
  ]);
  assertEquals(summarize(before, after), [
    ["unchanged", "system", "system", "u Be brief."],
    ["added", null, "assistant", "a Example answer."],
    ["unchanged", "user", "user", "u {{question}}"],
  ]);
});

Deno.test("an edited message is compared line by line with line numbers", () => {
  const before = chatVersion(1, [{ role: "system", content: "One\nTwo\nThree" }]);
  const after = chatVersion(2, [{ role: "system", content: "One\nTwo and a half\nThree" }]);
  const [contentChange] = comparePromptVersions(before, after).contentChanges;
  assertEquals(contentChange.change, "changed");
  assertEquals(
    contentChange.lines.map((line) => [line.change, line.fromLineNumber, line.toLineNumber]),
    [
      ["unchanged", 1, 1],
      ["removed", 2, null],
      ["added", null, 2],
      ["unchanged", 3, 3],
    ],
  );
});

Deno.test("a message whose role changed is removed and added, not edited", () => {
  const before = chatVersion(1, [{ role: "user", content: "Hello" }]);
  const after = chatVersion(2, [{ role: "system", content: "Hello" }]);
  assertEquals(summarize(before, after), [
    ["removed", "user", null, "r Hello"],
    ["added", null, "system", "a Hello"],
  ]);
});

Deno.test("text prompts are compared as one block without a role", () => {
  assertEquals(summarize(textVersion(1, "Hi\nthere"), textVersion(2, "Hi\neveryone")), [
    ["changed", null, null, "u Hi | r there | a everyone"],
  ]);
});

Deno.test("identical versions have no changes", () => {
  const version = chatVersion(1, [{ role: "user", content: "Same" }]);
  const comparison = comparePromptVersions(version, { ...version, versionNumber: 2 });
  assertEquals(comparison.hasChanges, false);
});

Deno.test("a change of template type counts as a change", () => {
  const comparison = comparePromptVersions(
    textVersion(1, "Same"),
    chatVersion(2, [{ role: "user", content: "Same" }]),
  );
  assertEquals(comparison.hasChanges, true);
});

Deno.test("provider options compare by value, not by key order", () => {
  const before = {
    ...chatVersion(1, []),
    modelParameters: { ...NO_MODEL_PARAMETERS, providerOptions: { format: { b: 1, a: 2 } } },
  };
  const after = {
    ...chatVersion(2, []),
    modelParameters: { ...NO_MODEL_PARAMETERS, providerOptions: { format: { a: 2, b: 1 } } },
  };
  assertEquals(comparePromptVersions(before, after).hasChanges, false);
});
