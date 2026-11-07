import { assertEquals } from "@std/assert";
import {
  createNewPromptVersion,
  extractTemplateVariables,
} from "../src/prompts/prompt-versions.ts";

Deno.test("finds each variable once, in order of first appearance", () => {
  assertEquals(
    extractTemplateVariables({
      type: "chat",
      messages: [
        { role: "system", content: "You work for {{company}}. Reply in {{ language }}." },
        { role: "user", content: "{{question}} ({{company}})" },
      ],
    }),
    ["company", "language", "question"],
  );
});

Deno.test("ignores braces that are not a variable", () => {
  assertEquals(
    extractTemplateVariables({
      type: "text",
      text: 'Return {"answer": "..."} or {{ 1x }} or {single} or {{valid_name2}}.',
    }),
    ["valid_name2"],
  );
});

Deno.test("fills in unset model parameters and drops duplicate labels", () => {
  const newVersion = createNewPromptVersion({
    type: "text",
    text: "Hello",
    modelParameters: { temperature: 0 },
    commitMessage: "   ",
    labels: ["production", "production"],
  });
  assertEquals(newVersion.modelParameters, {
    model: null,
    temperature: 0,
    maxOutputTokens: null,
    topP: null,
    providerOptions: {},
  });
  assertEquals(newVersion.commitMessage, null);
  assertEquals(newVersion.labelNames, ["production"]);
});
