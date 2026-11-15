/** Sealing Evaluation's stored secrets again after the master key changed. */
import { assertEquals } from "@std/assert";
import { generateMasterKey } from "@extispex/service-runtime";
import { createEvaluationSecretCiphers, resealEvaluationSecrets } from "../src/create-service.ts";
import {
  defineEvaluationTest,
  expectJson,
  sendRequest,
  TEST_MASTER_KEY,
} from "./evaluation-test-harness.ts";

interface StoredSecrets {
  targetId: string;
  credential: string;
  projectId: string;
  smtpPassword: string;
  teamsWebhookUrl: string;
  providerId: string;
  apiKey: string;
}

async function readStoredSecrets(
  harness: Parameters<Parameters<typeof defineEvaluationTest>[1]>[0],
): Promise<StoredSecrets> {
  const connection = harness.database.orm.em.fork().getConnection();
  const [target] = await connection.execute<{ id: string; sealed_credential_value: string }[]>(
    "select id, sealed_credential_value from targets",
  );
  const [settings] = await connection.execute<
    { project_id: string; sealed_smtp_password: string; sealed_teams_webhook_url: string }[]
  >("select project_id, sealed_smtp_password, sealed_teams_webhook_url from report_settings");
  const [provider] = await connection.execute<{ id: string; sealed_api_key: string }[]>(
    "select id, sealed_api_key from llm_providers",
  );
  return {
    targetId: target.id,
    credential: target.sealed_credential_value,
    projectId: settings.project_id,
    smtpPassword: settings.sealed_smtp_password,
    teamsWebhookUrl: settings.sealed_teams_webhook_url,
    providerId: provider.id,
    apiKey: provider.sealed_api_key,
  };
}

defineEvaluationTest("seals every stored secret again with a new master key", async (harness) => {
  await expectJson(
    sendRequest(harness, "POST", "/v1/targets", {
      body: {
        name: "support-bot",
        url: harness.target.url,
        credential: { headerName: "Authorization", headerValue: "Bearer target-secret" },
      },
    }),
    201,
  );
  await expectJson(
    sendRequest(harness, "PUT", "/v1/report-settings", {
      body: {
        condition: "always",
        email: {
          smtpHost: "smtp.company.example",
          smtpPort: 587,
          smtpSecurity: "starttls",
          smtpUsername: "reports@company.example",
          smtpPassword: "smtp-secret",
          fromAddress: "extispex@company.example",
          recipients: ["team@company.example"],
        },
        teams: { webhookUrl: "https://company.logic.azure.com/workflows/secret" },
      },
    }),
    200,
  );
  await expectJson(
    sendRequest(harness, "POST", "/v1/llm-providers", {
      body: {
        name: "judge",
        kind: "openai_compatible",
        baseUrl: `${harness.llmProvider.url}/v1`,
        defaultModel: "gpt-test",
        apiKey: "provider-secret",
      },
    }),
    201,
  );
  const before = await readStoredSecrets(harness);

  const newMasterKey = generateMasterKey();
  const rotating = await createEvaluationSecretCiphers({
    current: newMasterKey,
    previous: TEST_MASTER_KEY,
  });
  const resealedOnce = { resealedCount: 1, currentCount: 0 };
  assertEquals(await resealEvaluationSecrets(harness.database, rotating), {
    targetCredentials: resealedOnce,
    smtpPasswords: resealedOnce,
    teamsWebhookUrls: resealedOnce,
    llmProviderApiKeys: resealedOnce,
  });
  const alreadyCurrent = { resealedCount: 0, currentCount: 1 };
  assertEquals(await resealEvaluationSecrets(harness.database, rotating), {
    targetCredentials: alreadyCurrent,
    smtpPasswords: alreadyCurrent,
    teamsWebhookUrls: alreadyCurrent,
    llmProviderApiKeys: alreadyCurrent,
  });

  // The previous key is no longer needed: the new one alone opens every value.
  const after = await readStoredSecrets(harness);
  const newOnly = await createEvaluationSecretCiphers(newMasterKey);
  assertEquals(
    await newOnly.targetCredential.open(after.credential, after.targetId),
    "Bearer target-secret",
  );
  assertEquals(
    await newOnly.reportChannel.open(after.smtpPassword, `${after.projectId}:smtp-password`),
    "smtp-secret",
  );
  assertEquals(
    await newOnly.reportChannel.open(
      after.teamsWebhookUrl,
      `${after.projectId}:teams-webhook-url`,
    ),
    "https://company.logic.azure.com/workflows/secret",
  );
  assertEquals(
    await newOnly.llmProviderApiKey.open(after.apiKey, after.providerId),
    "provider-secret",
  );
  assertEquals(before.credential === after.credential, false);
});
