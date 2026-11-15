import { type ResealOutcome, resealSecrets, type SecretCipher } from "@extispex/service-runtime";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import { LlmProviderRecord, ReportSettingsRecord, TargetRecord } from "./evaluation-entities.ts";

/** The ciphers of every purpose Evaluation seals values for. */
export interface EvaluationSecretCiphers {
  targetCredential: SecretCipher;
  reportChannel: SecretCipher;
  llmProviderApiKey: SecretCipher;
}

export interface EvaluationResealOutcome {
  targetCredentials: ResealOutcome;
  smtpPasswords: ResealOutcome;
  teamsWebhookUrls: ResealOutcome;
  llmProviderApiKeys: ResealOutcome;
}

/**
 * Seals every stored secret again with the current master key, after `MASTER_KEY` changed and the
 * previous key moved to `PREVIOUS_MASTER_KEY`. Each value is replaced only if it is still the one
 * read, so runs at the same time, or a user changing a Target meanwhile, lose nothing.
 */
export async function resealEvaluationSecrets(
  database: EvaluationDatabase,
  ciphers: EvaluationSecretCiphers,
): Promise<EvaluationResealOutcome> {
  const entityManager = database.orm.em.fork();

  const targets = await entityManager.find(TargetRecord, { sealedCredentialValue: { $ne: null } });
  const targetCredentials = await resealSecrets(
    ciphers.targetCredential,
    targets.map((target) => ({
      associatedData: target.id,
      sealedSecret: target.sealedCredentialValue!,
    })),
    async (stored, resealed) =>
      await entityManager.nativeUpdate(
        TargetRecord,
        { id: stored.associatedData, sealedCredentialValue: stored.sealedSecret },
        { sealedCredentialValue: resealed },
      ) === 1,
  );

  const reportSettings = await entityManager.find(ReportSettingsRecord, {
    $or: [{ sealedSmtpPassword: { $ne: null } }, { sealedTeamsWebhookUrl: { $ne: null } }],
  });
  // The bindings are those of report-settings-repository.ts.
  const smtpPasswords = await resealSecrets(
    ciphers.reportChannel,
    reportSettings.filter((settings) => settings.sealedSmtpPassword != null).map((settings) => ({
      associatedData: `${settings.projectId}:smtp-password`,
      sealedSecret: settings.sealedSmtpPassword!,
    })),
    async (stored, resealed) =>
      await entityManager.nativeUpdate(
        ReportSettingsRecord,
        {
          projectId: stored.associatedData.replace(/:smtp-password$/, ""),
          sealedSmtpPassword: stored.sealedSecret,
        },
        { sealedSmtpPassword: resealed },
      ) === 1,
  );
  const teamsWebhookUrls = await resealSecrets(
    ciphers.reportChannel,
    reportSettings.filter((settings) => settings.sealedTeamsWebhookUrl != null).map((
      settings,
    ) => ({
      associatedData: `${settings.projectId}:teams-webhook-url`,
      sealedSecret: settings.sealedTeamsWebhookUrl!,
    })),
    async (stored, resealed) =>
      await entityManager.nativeUpdate(
        ReportSettingsRecord,
        {
          projectId: stored.associatedData.replace(/:teams-webhook-url$/, ""),
          sealedTeamsWebhookUrl: stored.sealedSecret,
        },
        { sealedTeamsWebhookUrl: resealed },
      ) === 1,
  );

  const providers = await entityManager.find(LlmProviderRecord, { sealedApiKey: { $ne: null } });
  const llmProviderApiKeys = await resealSecrets(
    ciphers.llmProviderApiKey,
    providers.map((provider) => ({
      associatedData: provider.id,
      sealedSecret: provider.sealedApiKey!,
    })),
    async (stored, resealed) =>
      await entityManager.nativeUpdate(
        LlmProviderRecord,
        { id: stored.associatedData, sealedApiKey: stored.sealedSecret },
        { sealedApiKey: resealed },
      ) === 1,
  );

  return { targetCredentials, smtpPasswords, teamsWebhookUrls, llmProviderApiKeys };
}
