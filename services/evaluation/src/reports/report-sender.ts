import nodemailer from "nodemailer";
import type { EmailChannelForSending } from "../storage/mod.ts";
import {
  type DestinationAllowlist,
  DestinationNotAllowedError,
  postToAllowedDestination,
  type ProxyRouting,
  resolveAllowedAddresses,
  type ResolveHostAddresses,
  resolveWithSystem,
} from "../targets/mod.ts";
import type { EmailReport } from "./report-content.ts";

export const DEFAULT_REPORT_TIMEOUT_MILLISECONDS = 30_000;

/** A webhook answers with a short acknowledgement; anything longer is not read. */
const MAXIMUM_WEBHOOK_RESPONSE_BYTES = 65_536;
const NOT_ALLOWED_REASON =
  "This channel's address is not allowed by EVALUATION_REPORT_ALLOWED_DESTINATIONS.";

export type DeliveryResult = { status: "delivered" } | { status: "failed"; reason: string };

/** Sends a Report to one channel. Never rejects: whatever goes wrong is the delivery's failure. */
export interface ReportSender {
  sendEmail(channel: EmailChannelForSending, report: EmailReport): Promise<DeliveryResult>;
  postToTeams(webhookUrl: string, message: unknown): Promise<DeliveryResult>;
}

export interface ReportSenderOptions {
  allowlist: DestinationAllowlist;
  timeoutMilliseconds: number;
  /** The system's resolver by default. */
  resolveHostAddresses?: ResolveHostAddresses;
  /** For webhooks: `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. SMTP is always direct. */
  proxyRouting?: ProxyRouting;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejects after the time limit, so that a server that stops answering cannot hold the worker. */
function withTimeout<Result>(
  work: Promise<Result>,
  timeoutMilliseconds: number,
  onTimeout: () => void,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rejectTimeout) => {
    timer = setTimeout(() => {
      onTimeout();
      rejectTimeout(new Error(`No answer within ${timeoutMilliseconds} ms.`));
    }, timeoutMilliseconds);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createReportSender(options: ReportSenderOptions): ReportSender {
  const { allowlist, timeoutMilliseconds } = options;
  const resolveHostAddresses = options.resolveHostAddresses ?? resolveWithSystem;
  const destinationOptions = {
    allowlist,
    resolveHostAddresses,
    notAllowedReason: NOT_ALLOWED_REASON,
  };

  return {
    async sendEmail(channel, report) {
      const serverUrl = new URL(`smtp://${channel.smtpHost}:${channel.smtpPort}`);
      if (!allowlist.isUrlAllowed(serverUrl)) {
        return { status: "failed", reason: NOT_ALLOWED_REASON };
      }
      let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
      try {
        // The connection goes to the address that was checked, and TLS still checks the
        // certificate against the configured host name.
        const [address] = await resolveAllowedAddresses(serverUrl, destinationOptions);
        const hostName = serverUrl.hostname.replace(/^\[|\]$/g, "");
        transport = nodemailer.createTransport({
          host: address.address,
          port: channel.smtpPort,
          secure: channel.smtpSecurity === "tls",
          requireTLS: channel.smtpSecurity === "starttls",
          ignoreTLS: channel.smtpSecurity === "none",
          tls: { servername: hostName },
          auth: channel.smtpUsername === null
            ? undefined
            : { user: channel.smtpUsername, pass: channel.smtpPassword ?? "" },
          connectionTimeout: timeoutMilliseconds,
          greetingTimeout: timeoutMilliseconds,
          socketTimeout: timeoutMilliseconds,
        });
        const openTransport = transport;
        await withTimeout(
          openTransport.sendMail({
            from: channel.fromAddress,
            to: channel.recipients,
            subject: report.subject,
            text: report.text,
            html: report.html,
          }),
          timeoutMilliseconds,
          () => openTransport.close(),
        );
        return { status: "delivered" };
      } catch (error) {
        if (error instanceof DestinationNotAllowedError) {
          return { status: "failed", reason: error.message };
        }
        return {
          status: "failed",
          reason: `The SMTP server did not accept the Report: ${describeError(error)}`,
        };
      } finally {
        transport?.close();
      }
    },

    async postToTeams(webhookUrl, message) {
      const url = new URL(webhookUrl);
      if (!allowlist.isUrlAllowed(url)) return { status: "failed", reason: NOT_ALLOWED_REASON };
      const signal = AbortSignal.timeout(timeoutMilliseconds);
      try {
        const result = await postToAllowedDestination(
          url,
          { "content-type": "application/json" },
          JSON.stringify(message),
          {
            ...destinationOptions,
            maximumResponseBytes: MAXIMUM_WEBHOOK_RESPONSE_BYTES,
            proxyRouting: options.proxyRouting,
          },
          signal,
        );
        // A long answer is still an answer: the webhook took the message.
        if ("status" in result) return { status: "delivered" };
        if (result.statusCode >= 200 && result.statusCode < 300) return { status: "delivered" };
        if (result.statusCode >= 300 && result.statusCode < 400) {
          return {
            status: "failed",
            reason:
              `The webhook answered with a redirect (${result.statusCode}), which is not followed.`,
          };
        }
        return {
          status: "failed",
          reason: `The webhook answered with status ${result.statusCode}: ${
            result.body.slice(0, 300)
          }`,
        };
      } catch (error) {
        if (error instanceof DestinationNotAllowedError) {
          return { status: "failed", reason: error.message };
        }
        if (signal.aborted) {
          return {
            status: "failed",
            reason: `The webhook did not answer within ${timeoutMilliseconds} ms.`,
          };
        }
        return {
          status: "failed",
          reason: `The webhook could not be reached: ${describeError(error)}`,
        };
      }
    },
  };
}
