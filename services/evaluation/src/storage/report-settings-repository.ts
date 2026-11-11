import type {
  ReportCondition,
  ReportSettings,
  SmtpSecurity,
  UpdateReportSettingsRequest,
} from "@extispex/contracts";
import type { SecretCipher } from "@extispex/service-runtime";
import type { InferEntity } from "@mikro-orm/core";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import { ReportSettingsRecord, type StoredEmailChannel } from "./evaluation-entities.ts";

type ReportSettingsRow = InferEntity<typeof ReportSettingsRecord>;

/** What a Project that never saved its settings has: no channel, so no Report. */
const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  condition: "always",
  email: null,
  teams: null,
  updatedAt: null,
};

/** The worker's view of the email channel, with the password opened. */
export interface EmailChannelForSending {
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUsername: string | null;
  smtpPassword: string | null;
  fromAddress: string;
  recipients: string[];
}

export interface ReportChannelsForSending {
  email: EmailChannelForSending | null;
  teamsWebhookUrl: string | null;
}

export type SaveReportSettingsResult =
  | { status: "saved"; settings: ReportSettings }
  | { status: "invalid"; message: string };

export interface ReportSettingsRepository {
  readSettings(projectId: string): Promise<ReportSettings>;
  saveSettings(
    projectId: string,
    request: UpdateReportSettingsRequest,
    updatedAt: Date,
  ): Promise<SaveReportSettingsResult>;
  /** The channels with their secrets opened, for the worker that sends a Report. */
  readChannelsForSending(projectId: string): Promise<ReportChannelsForSending>;
}

/** Each secret is bound to its Project and field, so a sealed value cannot be moved elsewhere. */
function smtpPasswordBinding(projectId: string): string {
  return `${projectId}:smtp-password`;
}

function teamsWebhookBinding(projectId: string): string {
  return `${projectId}:teams-webhook-url`;
}

function toReportSettings(row: ReportSettingsRow): ReportSettings {
  return {
    condition: row.condition as ReportCondition,
    email: row.emailChannel == null
      ? null
      : { ...row.emailChannel, hasSmtpPassword: row.sealedSmtpPassword != null },
    teams: row.teamsWebhookHost == null ? null : { webhookHost: row.teamsWebhookHost },
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createReportSettingsRepository(
  database: EvaluationDatabase,
  channelCipher: SecretCipher,
): ReportSettingsRepository {
  return {
    async readSettings(projectId) {
      const row = await database.orm.em.fork().findOne(ReportSettingsRecord, { projectId });
      return row === null ? DEFAULT_REPORT_SETTINGS : toReportSettings(row);
    },

    async saveSettings(projectId, request, updatedAt) {
      const entityManager = database.orm.em.fork();
      const existing = await entityManager.findOne(ReportSettingsRecord, { projectId });
      const email = request.email;
      let emailChannel: StoredEmailChannel | null = null;
      let sealedSmtpPassword: string | null = null;
      if (email !== null) {
        const smtpUsername = email.smtpUsername ?? null;
        if (smtpUsername !== null) {
          if (email.smtpPassword === null) {
            return { status: "invalid", message: "An SMTP user name needs its password." };
          }
          sealedSmtpPassword = email.smtpPassword === undefined
            ? existing?.sealedSmtpPassword ?? null
            : await channelCipher.seal(email.smtpPassword, smtpPasswordBinding(projectId));
          if (sealedSmtpPassword === null) {
            return { status: "invalid", message: "Enter the SMTP password for this user name." };
          }
        }
        emailChannel = {
          smtpHost: email.smtpHost.trim(),
          smtpPort: email.smtpPort,
          smtpSecurity: email.smtpSecurity,
          smtpUsername,
          fromAddress: email.fromAddress,
          recipients: [...new Set(email.recipients)],
        };
      }
      let sealedTeamsWebhookUrl: string | null = null;
      let teamsWebhookHost: string | null = null;
      if (request.teams !== null) {
        const webhookUrl = request.teams.webhookUrl;
        if (webhookUrl === undefined) {
          sealedTeamsWebhookUrl = existing?.sealedTeamsWebhookUrl ?? null;
          teamsWebhookHost = existing?.teamsWebhookHost ?? null;
          if (sealedTeamsWebhookUrl === null) {
            return { status: "invalid", message: "Enter the Teams webhook URL." };
          }
        } else {
          sealedTeamsWebhookUrl = await channelCipher.seal(
            webhookUrl,
            teamsWebhookBinding(projectId),
          );
          teamsWebhookHost = new URL(webhookUrl).host;
        }
      }
      const row = {
        projectId,
        condition: request.condition,
        emailChannel,
        sealedSmtpPassword,
        sealedTeamsWebhookUrl,
        teamsWebhookHost,
        updatedAt,
      };
      await entityManager.upsert(ReportSettingsRecord, row);
      return { status: "saved", settings: toReportSettings(row as ReportSettingsRow) };
    },

    async readChannelsForSending(projectId) {
      const row = await database.orm.em.fork().findOne(ReportSettingsRecord, { projectId });
      if (row === null) return { email: null, teamsWebhookUrl: null };
      const { emailChannel, sealedSmtpPassword, sealedTeamsWebhookUrl } = row;
      return {
        email: emailChannel == null ? null : {
          ...emailChannel,
          smtpPassword: sealedSmtpPassword == null
            ? null
            : await channelCipher.open(sealedSmtpPassword, smtpPasswordBinding(projectId)),
        },
        teamsWebhookUrl: sealedTeamsWebhookUrl == null
          ? null
          : await channelCipher.open(sealedTeamsWebhookUrl, teamsWebhookBinding(projectId)),
      };
    },
  };
}
