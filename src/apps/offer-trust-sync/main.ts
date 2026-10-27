import {LoggerService} from "../../services/loggerService";
import {SlackService} from "../../services/slackService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {formatErrorWithCauses} from "../../formatError";
import {recordRunError, recordRunSuccess, startMetricsServer} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {resolveTransactionRpcUrl} from "../../services/transactionRpc";
import {OfferCycleService} from "../../services/offerCycleService";
import {computeNextDelayMs, DEFAULT_OFFER_CYCLE_ADDRESS, runOnce, type RunConfig} from "./logic";

const appName = "offer-trust-sync";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const rootLogger = new LoggerService(verboseLogging, appName);

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const cycleAddress = process.env.OFFER_TRUST_SYNC_CYCLE_ADDRESS || DEFAULT_OFFER_CYCLE_ADDRESS;
const signerPrivateKey = process.env.OFFER_TRUST_SYNC_SIGNER_PRIVATE_KEY || "";
const dryRun = process.env.DRY_RUN === "1";
const pollIntervalMs = parseEnvInt("OFFER_TRUST_SYNC_POLL_INTERVAL_MS", 5 * 60 * 1000);
// A run timed for the period start waits this long past it, so the block it
// reads already carries a timestamp in the new period.
const boundaryMarginMs = parseEnvInt("OFFER_TRUST_SYNC_BOUNDARY_MARGIN_MS", 30 * 1000);
const errorsBeforeCrash = Math.max(1, parseEnvInt("OFFER_TRUST_SYNC_ERRORS_BEFORE_CRASH", 3));
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";

process.env.APP_NAME = appName;
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const slackConfigured = slackWebhookUrl.trim().length > 0;
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
const runLogger = rootLogger.child("run");

if (!dryRun && signerPrivateKey.trim().length === 0) {
  throw new Error("OFFER_TRUST_SYNC_SIGNER_PRIVATE_KEY is required when offer-trust-sync is not running in dry-run mode.");
}

const offerCycle = new OfferCycleService(rpcUrl, cycleAddress, signerPrivateKey, txRpcUrl);
const config: RunConfig = {dryRun};

rootLogger.info("Starting offer-trust-sync with config:");
rootLogger.info(`  - rpcUrl=${rpcUrl}`);
rootLogger.info(`  - txRpcUrl=${txRpcUrl}`);
rootLogger.info(`  - cycleAddress=${cycleAddress}`);
rootLogger.info(`  - eoaSignerAddress=${offerCycle.getSignerAddress() ?? "(not set)"}`);
rootLogger.info(`  - pollIntervalMs=${pollIntervalMs}`);
rootLogger.info(`  - boundaryMarginMs=${boundaryMarginMs}`);
rootLogger.info(`  - dryRun=${dryRun}`);

void notifySlackStartup();

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

process.on("uncaughtException", async (error) => {
  rootLogger.error("Uncaught exception:", formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
  try {
    await slackService.notifySlackStartOrCrash(`*offer-trust-sync* Uncaught exception: ${error?.message || error}`, SlackSeverity.CRITICAL);
  } catch (slackErr) {
    console.error("Failed to send Slack crash notification:", slackErr);
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(error));
  try {
    await slackService.notifySlackStartOrCrash(`*offer-trust-sync* Unhandled rejection: ${error.message}`, SlackSeverity.CRITICAL);
  } catch (slackErr) {
    console.error("Failed to send Slack crash notification:", slackErr);
  }
  process.exit(1);
});

async function mainLoop(): Promise<void> {
  startMetricsServer(appName);
  const maxDelay = Math.min(pollIntervalMs * 4, 15 * 60 * 1000);
  let errorDelay = pollIntervalMs;

  while (true) {
    const runStartedAt = Date.now();
    let nextDelay = pollIntervalMs;

    try {
      const isHealthy = await ensureRpcHealthyOrNotify({appName, rpcUrl, logger: rootLogger});
      if (!isHealthy) {
        await delay(errorDelay);
        continue;
      }

      const outcome = await runOnce({offerCycle, logger: runLogger}, config);

      recordRunSuccess(appName, Date.now() - runStartedAt);
      errorTracker.recordSuccess();
      if (errorTracker.wasAlertingAndRecovered()) {
        slackService.notifySlackResolved(appName).catch((err) => {
          rootLogger.warn("Failed to send Slack resolved notification:", err);
        });
      }
      errorDelay = pollIntervalMs;
      nextDelay = computeNextDelayMs(outcome.blockTimestamp, outcome.nextPeriodStart, pollIntervalMs, boundaryMarginMs);

      runLogger.info(
        "offer-trust-sync run completed: " +
        `offerId=${outcome.offerId} ` +
        `acceptedCrc=${outcome.acceptedCrcCount} ` +
        `outOfSync=${outcome.outOfSync.length} ` +
        `tx=${outcome.txHash ?? "none"} ` +
        `nextRunInMs=${nextDelay} ` +
        `dryRun=${dryRun}`
      );

      if (outcome.txHash) {
        void slackService.notifySlackStartOrCrash(
          `*offer-trust-sync* synced Hub trust for offer ${outcome.offerId}\n` +
          `- Cycle: ${cycleAddress}\n` +
          `- Accepted CRC: ${outcome.outOfSync.join(", ")}\n` +
          `- Tx: ${outcome.txHash}`,
          SlackSeverity.INFO
        ).catch((e) => rootLogger.warn("Failed to send Slack sync notification:", e));
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError(appName);
      rootLogger.error(`Consecutive error ${consecutiveErrors} of ${errorsBeforeCrash}`);
      rootLogger.error(formatErrorWithCauses(error));
      if (errorTracker.shouldAlert()) {
        rootLogger.error("Consecutive error threshold reached. Exiting with code 1.");
        void notifySlackRunError(error, consecutiveErrors).catch((e) => rootLogger.warn("Failed to send Slack notification:", e));
        setTimeout(() => process.exit(1), 3000).unref();
        return;
      }
      errorDelay = Math.min(errorDelay * 2, maxDelay);
      nextDelay = errorDelay;
    }

    await delay(nextDelay);
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  try {
    await slackService.notifySlackStartOrCrash(
      `*offer-trust-sync shutting down*\n\nService received ${signal} signal.`,
      SlackSeverity.INFO
    );
  } catch (error) {
    rootLogger.error("Failed to send shutdown notification:", error);
  }
  process.exit(0);
}

mainLoop().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("offer-trust-sync crashed:");
  rootLogger.error(formatErrorWithCauses(error));
  void slackService.notifySlackStartOrCrash(
    `*offer-trust-sync crashed*\n\nLast error: ${error.message}`,
    SlackSeverity.CRITICAL
  ).catch((slackError: unknown) => {
    rootLogger.warn("Failed to send crash notification to Slack:", slackError);
  });
  process.exit(1);
});

async function notifySlackStartup(): Promise<void> {
  const message = `*offer-trust-sync started*\n\n` +
    `Keeps the offer cycle's Hub trust to the current offer's accepted CRC set to the offer end.\n` +
    `- RPC: ${rpcUrl}\n` +
    `- TX RPC: ${txRpcUrl}\n` +
    `- Cycle: ${cycleAddress}\n` +
    `- EOA signer: ${offerCycle.getSignerAddress() ?? "(not set)"}\n` +
    `- Poll Interval (ms): ${pollIntervalMs}\n` +
    `- Dry Run: ${dryRun}`;

  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.INFO);
    if (slackConfigured) {
      rootLogger.info("Slack startup notification sent.");
    } else {
      rootLogger.info("Slack startup notification skipped (no webhook configured).");
    }
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack startup notification:", slackError);
  }
}

async function notifySlackRunError(error: Error, consecutiveErrors: number): Promise<void> {
  const message = `*offer-trust-sync run failed* (${consecutiveErrors} consecutive failures)\n\n${formatErrorWithCauses(error)}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.WARNING);
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack run-error notification:", slackError);
  }
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) {
    rootLogger.warn(`Invalid non-negative integer for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }

  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
