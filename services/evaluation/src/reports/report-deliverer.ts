import type { StructuredLogger } from "@extispex/service-runtime";
import type { DeliverReportJob, JobQueue } from "../job-queue/mod.ts";
import type {
  ClaimedDelivery,
  ReportDeliveryRepository,
  ReportSettingsRepository,
} from "../storage/mod.ts";
import { buildReportContent, renderEmailReport, renderTeamsMessage } from "./report-content.ts";
import type { DeliveryResult, ReportSender } from "./report-sender.ts";

/** The first try and four retries. */
export const REPORT_DELIVERY_ATTEMPTS = 5;
/** The wait before the first retry; each later wait is four times longer: 1, 4, 16 and 64 min. */
export const DEFAULT_REPORT_RETRY_DELAY_MILLISECONDS = 60_000;
/** A delivery whose job has not run this long after it was due is queued again. */
const STALLED_DELIVERY_MILLISECONDS = 120_000;
/**
 * A Report waits this long after the run finished for its LLM Summary, which is written after the
 * run ends; then it goes out without one.
 */
export const LLM_SUMMARY_WAIT_MILLISECONDS = 300_000;
/** How often a waiting Report looks again whether the LLM Summary is there. */
export const LLM_SUMMARY_POLL_MILLISECONDS = 5_000;

export interface ReportDelivererDependencies {
  reportDeliveryRepository: ReportDeliveryRepository;
  reportSettingsRepository: ReportSettingsRepository;
  reportSender: ReportSender;
  jobQueue: JobQueue;
  /** Where people open the UI, for the links in a Report; null leaves the links out. */
  publicUiUrl: string | null;
  retryDelayMilliseconds: number;
  logger: StructuredLogger;
  readCurrentTime: () => Date;
}

export interface ReportDeliverer {
  /** Sends one channel's Report, or schedules a retry. Safe to repeat. */
  deliverReport(job: DeliverReportJob): Promise<void>;
  /** Queues deliveries again whose job was lost; resolves to how many. */
  requeueStalledDeliveries(): Promise<number>;
}

export function retryDelayAfter(attemptNumber: number, baseDelayMilliseconds: number): number {
  return baseDelayMilliseconds * 4 ** (attemptNumber - 1);
}

export function createReportDeliverer(dependencies: ReportDelivererDependencies): ReportDeliverer {
  const { reportDeliveryRepository, jobQueue, logger, readCurrentTime } = dependencies;

  const send = async (claim: ClaimedDelivery): Promise<DeliveryResult> => {
    const channels = await dependencies.reportSettingsRepository.readChannelsForSending(
      claim.projectId,
    );
    const facts = await reportDeliveryRepository.readReportFacts(claim.runId);
    if (facts === null) return { status: "failed", reason: "The run has not finished." };
    const content = buildReportContent(facts, dependencies.publicUiUrl);
    if (claim.channel === "email") {
      if (channels.email === null) {
        return { status: "failed", reason: "Email was turned off before the Report was sent." };
      }
      return await dependencies.reportSender.sendEmail(channels.email, renderEmailReport(content));
    }
    if (channels.teamsWebhookUrl === null) {
      return { status: "failed", reason: "Teams was turned off before the Report was sent." };
    }
    return await dependencies.reportSender.postToTeams(
      channels.teamsWebhookUrl,
      renderTeamsMessage(content),
    );
  };

  return {
    async deliverReport(job) {
      const summaryWait = await reportDeliveryRepository.readLlmSummaryWait(job.deliveryId);
      const now = readCurrentTime();
      if (
        summaryWait?.isLlmSummaryPending &&
        now.getTime() - summaryWait.finishedAt.getTime() < LLM_SUMMARY_WAIT_MILLISECONDS
      ) {
        await reportDeliveryRepository.postponeDelivery(
          job.deliveryId,
          new Date(now.getTime() + LLM_SUMMARY_POLL_MILLISECONDS),
        );
        await jobQueue.enqueue([job], { delayMilliseconds: LLM_SUMMARY_POLL_MILLISECONDS });
        return;
      }
      const claim = await reportDeliveryRepository.claimDelivery(job.deliveryId, readCurrentTime());
      if (claim === null) return;
      let result: DeliveryResult;
      try {
        result = await send(claim);
      } catch (error) {
        logger.error("A Report could not be prepared", { error, deliveryId: job.deliveryId });
        result = { status: "failed", reason: "The Report could not be prepared." };
      }
      if (result.status === "delivered") {
        await reportDeliveryRepository.recordDelivered(claim, readCurrentTime());
        return;
      }
      const canRetry = claim.attemptNumber < REPORT_DELIVERY_ATTEMPTS;
      const delayMilliseconds = retryDelayAfter(
        claim.attemptNumber,
        dependencies.retryDelayMilliseconds,
      );
      logger.info("A Report was not delivered", {
        deliveryId: job.deliveryId,
        channel: claim.channel,
        attemptNumber: claim.attemptNumber,
        reason: result.reason,
        willRetry: canRetry,
      });
      await reportDeliveryRepository.recordFailure(
        claim,
        result.reason,
        canRetry ? new Date(readCurrentTime().getTime() + delayMilliseconds) : null,
      );
      if (canRetry) await jobQueue.enqueue([job], { delayMilliseconds });
    },

    async requeueStalledDeliveries() {
      const now = readCurrentTime();
      const jobs = await reportDeliveryRepository.claimStalledDeliveries(
        new Date(now.getTime() - STALLED_DELIVERY_MILLISECONDS),
        now,
      );
      await jobQueue.enqueue(jobs);
      return jobs.length;
    },
  };
}
