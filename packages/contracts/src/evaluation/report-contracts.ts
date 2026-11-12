import { z } from "zod";

/** Whether a finished Evaluation Run sends a Report every time, or only when it did not pass. */
export const reportConditionSchema = z.enum(["always", "on_failure"]);

/**
 * How the SMTP connection is protected: `tls` from the first byte (usually port 465), `starttls`
 * upgraded and required (usually 587), or `none` for a relay inside the company's network.
 */
export const smtpSecuritySchema = z.enum(["tls", "starttls", "none"]);

export const reportChannelSchema = z.enum(["email", "teams"]);

/** How many addresses one Report email goes to. */
export const MAXIMUM_REPORT_RECIPIENTS = 50;

/** How many Test Cases that did not pass a Report lists. */
export const MAXIMUM_REPORTED_TEST_CASES = 10;

const reportEmailAddressSchema = z.string().trim().pipe(z.email().max(254));

/** A host name or an IP address, without a scheme or a port. */
const smtpHostSchema = z.string().trim().min(1).max(253).regex(
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.?)+$|^\[?[0-9A-Fa-f:.]+\]?$/,
  "Enter a host name or an IP address, without a scheme or a port.",
);

const webhookUrlSchema = z.string().trim().min(1).max(2_048).refine((url) => {
  if (!URL.canParse(url)) return false;
  const { protocol, username, password } = new URL(url);
  return (protocol === "http:" || protocol === "https:") && username === "" && password === "";
}, "Use an http or https URL without a user name or password.");

/**
 * Email over the company's SMTP server. Leaving `smtpPassword` out keeps the stored one, and `null`
 * removes it; it is stored encrypted and never returned.
 */
export const emailChannelRequestSchema = z.strictObject({
  smtpHost: smtpHostSchema,
  smtpPort: z.number().int().min(1).max(65_535),
  smtpSecurity: smtpSecuritySchema,
  smtpUsername: z.string().min(1).max(256).nullable().optional(),
  smtpPassword: z.string().min(1).max(1_024).nullable().optional(),
  fromAddress: reportEmailAddressSchema,
  recipients: z.array(reportEmailAddressSchema).min(1).max(MAXIMUM_REPORT_RECIPIENTS),
});

/**
 * A Teams channel through a Workflows webhook. The URL carries its own signature, so it is stored
 * encrypted and never returned; leaving it out keeps the stored one.
 */
export const teamsChannelRequestSchema = z.strictObject({
  webhookUrl: webhookUrlSchema.optional(),
});

/** `null` turns a channel off. */
export const updateReportSettingsRequestSchema = z.strictObject({
  condition: reportConditionSchema,
  email: emailChannelRequestSchema.nullable(),
  teams: teamsChannelRequestSchema.nullable(),
});

export const emailChannelSchema = z.object({
  smtpHost: z.string(),
  smtpPort: z.number().int(),
  smtpSecurity: smtpSecuritySchema,
  smtpUsername: z.string().nullable(),
  hasSmtpPassword: z.boolean(),
  fromAddress: z.string(),
  recipients: z.array(z.string()),
});

export const teamsChannelSchema = z.object({
  /** Only the host of the stored webhook URL, so that people can tell which one it is. */
  webhookHost: z.string(),
});

/** A Project's Report settings. A Project that never saved any sends no Report. */
export const reportSettingsSchema = z.object({
  condition: reportConditionSchema,
  email: emailChannelSchema.nullable(),
  teams: teamsChannelSchema.nullable(),
  /** Null until the settings are saved for the first time. */
  updatedAt: z.string().nullable(),
});

/**
 * `pending` waits for its first try or for a retry at `nextAttemptAt`. `failed` gave up after the
 * last attempt. A delivery never changes the run's result.
 */
export const reportDeliveryStatusSchema = z.enum(["pending", "sending", "delivered", "failed"]);

export const reportDeliverySchema = z.object({
  channel: reportChannelSchema,
  status: reportDeliveryStatusSchema,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  /** When a pending delivery is tried next; null when it is not waiting for a retry. */
  nextAttemptAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
});

export const listReportDeliveriesResponseSchema = z.object({
  reportDeliveries: z.array(reportDeliverySchema),
});

export type ReportCondition = z.infer<typeof reportConditionSchema>;
export type SmtpSecurity = z.infer<typeof smtpSecuritySchema>;
export type ReportChannel = z.infer<typeof reportChannelSchema>;
export type EmailChannelRequest = z.infer<typeof emailChannelRequestSchema>;
export type TeamsChannelRequest = z.infer<typeof teamsChannelRequestSchema>;
export type UpdateReportSettingsRequest = z.input<typeof updateReportSettingsRequestSchema>;
export type EmailChannel = z.infer<typeof emailChannelSchema>;
export type TeamsChannel = z.infer<typeof teamsChannelSchema>;
export type ReportSettings = z.infer<typeof reportSettingsSchema>;
export type ReportDeliveryStatus = z.infer<typeof reportDeliveryStatusSchema>;
export type ReportDelivery = z.infer<typeof reportDeliverySchema>;
export type ListReportDeliveriesResponse = z.infer<typeof listReportDeliveriesResponseSchema>;
