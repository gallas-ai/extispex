import { assert, assertEquals } from "@std/assert";
import type {
  ListPromptsResponse,
  ListPromptVersionsResponse,
  PromptLabel,
  PromptVersion,
  PromptVersionComparison,
} from "@extispex/contracts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";

async function callGateway<ResponseBody>(
  deployment: RunningDeployment,
  method: string,
  path: string,
  expectedStatus: number,
  requestBody?: unknown,
): Promise<ResponseBody> {
  const headers = new Headers({ authorization: `Bearer ${deployment.apiKey}` });
  if (requestBody !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${deployment.gatewayUrl}${path}`, {
    method,
    headers,
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });
  const responseText = await response.text();
  assertEquals(response.status, expectedStatus, `${method} ${path}: ${responseText}`);
  return (responseText === "" ? null : JSON.parse(responseText)) as ResponseBody;
}

Deno.test("prompt API through the gateway", async (testContext) => {
  const deployment = await startDeployment();
  // A fresh name keeps the test apart from prompts that other runs leave in a shared database.
  const promptName = `e2e-support-agent-${crypto.randomUUID().slice(0, 8)}`;
  const promptPath = `/v1/prompts/${promptName}`;
  try {
    await testContext.step("creates a prompt with its first version", async () => {
      const firstVersion = await callGateway<PromptVersion>(
        deployment,
        "POST",
        "/v1/prompts",
        201,
        {
          name: promptName,
          description: "Answers customer questions",
          type: "chat",
          messages: [
            { role: "system", content: "You help customers of {{company}}.\nBe brief." },
            { role: "user", content: "{{question}}" },
          ],
          modelParameters: { model: "gpt-4.1", temperature: 0.2 },
          labels: ["production"],
        },
      );
      assertEquals(firstVersion.versionNumber, 1);
      assertEquals(firstVersion.variables, ["company", "question"]);
    });

    await testContext.step("adds a version and moves a label to it", async () => {
      const secondVersion = await callGateway<PromptVersion>(
        deployment,
        "POST",
        `${promptPath}/versions`,
        201,
        {
          type: "chat",
          messages: [
            { role: "system", content: "You help customers of {{company}}.\nBe friendly." },
            { role: "user", content: "{{question}}" },
          ],
          modelParameters: { model: "gpt-4.1", temperature: 0.7 },
          commitMessage: "Friendlier tone",
        },
      );
      assertEquals(secondVersion.versionNumber, 2);

      const productionLabel = await callGateway<PromptLabel>(
        deployment,
        "PUT",
        `${promptPath}/labels/production`,
        200,
        { versionNumber: 2 },
      );
      assertEquals(productionLabel.versionNumber, 2);

      const productionVersion = await callGateway<PromptVersion>(
        deployment,
        "GET",
        `${promptPath}/labels/production`,
        200,
      );
      assertEquals(productionVersion.commitMessage, "Friendlier tone");
    });

    await testContext.step("lists the prompt and its versions", async () => {
      const { prompts } = await callGateway<ListPromptsResponse>(
        deployment,
        "GET",
        "/v1/prompts",
        200,
      );
      const listedPrompt = prompts.find((prompt) => prompt.name === promptName);
      assertEquals(listedPrompt?.latestVersionNumber, 2);
      assertEquals(listedPrompt?.labels.map((label) => label.name), ["production"]);

      const { versions } = await callGateway<ListPromptVersionsResponse>(
        deployment,
        "GET",
        `${promptPath}/versions`,
        200,
      );
      assertEquals(versions.map((version) => [version.versionNumber, version.labels]), [
        [2, ["production"]],
        [1, []],
      ]);
    });

    await testContext.step("compares two versions", async () => {
      const comparison = await callGateway<PromptVersionComparison>(
        deployment,
        "GET",
        `${promptPath}/compare?fromVersion=1&toVersion=2`,
        200,
      );
      assert(comparison.hasChanges);
      const changedLines = comparison.contentChanges.flatMap((contentChange) =>
        contentChange.lines.filter((line) => line.change !== "unchanged").map((line) =>
          `${line.change} ${line.text}`
        )
      );
      assertEquals(changedLines, ["removed Be brief.", "added Be friendly."]);
      const temperatureChange = comparison.modelParameterChanges.find((parameterChange) =>
        parameterChange.parameter === "temperature"
      );
      assertEquals([temperatureChange?.fromValue, temperatureChange?.toValue], [0.2, 0.7]);
    });

    await testContext.step(
      "documents the prompt API in the combined OpenAPI document",
      async () => {
        const openApiDocument = await callGateway<{ paths: Record<string, unknown> }>(
          deployment,
          "GET",
          "/v1/openapi.json",
          200,
        );
        assert("/v1/traces" in openApiDocument.paths);
        assert("/v1/prompts/{promptName}/compare" in openApiDocument.paths);
      },
    );

    await testContext.step("refuses prompt requests without a valid API key", async () => {
      const response = await fetch(`${deployment.gatewayUrl}/v1/prompts`, {
        headers: { authorization: "Bearer wrong-key" },
      });
      assertEquals(response.status, 401);
      await response.body?.cancel();
    });
  } finally {
    await deployment.stop();
  }
});
