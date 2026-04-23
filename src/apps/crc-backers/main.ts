import {CirclesRpcService} from "../../services/circlesRpcService";
import {ChainRpcService} from "../../services/chainRpcService";
import {BlacklistingService} from "../../services/blacklistingService";
import {SafeGroupService} from "../../services/safeGroupService";
import {BackingInstanceService} from "../../services/backingInstanceService";
import {SlackService} from "../../services/slackService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {LoggerService} from "../../services/loggerService";
import {runOnce} from "./logic";
import {formatErrorWithCauses} from "../../formatError";
import {startMetricsServer, recordRunSuccess, recordRunError, setLeaderStatus} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {LeaderElection, getEffectiveDryRun} from "../../services/leaderElection";
import {StateStore} from "../../services/stateStore";

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const blacklistingServiceUrl = process.env.BLACKLISTING_SERVICE_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist";
const backersGroupAddress = process.env.BACKERS_GROUP_ADDRESS || "0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026";
const backingFactoryAddress = process.env.BACKING_FACTORY_ADDRESS || "0xeced91232c609a42f6016860e8223b8aecaa7bd0";
const deployedAtBlock = Number.parseInt(process.env.START_AT_BLOCK || "39743285");
const expectedTimeTillCompletion = Number.parseInt(process.env.EXPECTED_SECONDS_TILL_COMPLETION || "60");
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const confirmationBlocks = Number.parseInt(process.env.CONFIRMATION_BLOCKS || "2");
const safeAddress = process.env.CRC_BACKERS_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.CRC_BACKERS_SAFE_SIGNER_PRIVATE_KEY || "";
const dryRun = process.env.DRY_RUN === "1";
const errorsBeforeCrash = 3;

const rootLogger = new LoggerService(verboseLogging);

const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
let leaderElection: LeaderElection | null = null;

if (!dryRun) {
  if (!safeSignerPrivateKey || safeSignerPrivateKey.trim().length === 0) {
    throw new Error("CRC_BACKERS_SAFE_SIGNER_PRIVATE_KEY is required when not running crc-backers in dry-run mode");
  }

  if (!safeAddress || safeAddress.trim().length === 0) {
    throw new Error("CRC_BACKERS_SAFE_ADDRESS is required when not running crc-backers in dry-run mode");
  }
}

// Concrete services
const circlesRpc = new CirclesRpcService(rpcUrl);
const chainRpc = new ChainRpcService(rpcUrl);
const blacklistingService = new BlacklistingService(blacklistingServiceUrl);
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const groupService = dryRun ? undefined : new SafeGroupService(rpcUrl, safeSignerPrivateKey, safeAddress);
// In dry-run mode, skip passing signer keys so BackingInstanceService doesn't
// eagerly initialise Safe Protocol Kit (which calls eth_chainId via viem).
// simulate* methods only use the ethers provider; execute methods throw if needed.
const cowSwapService = new BackingInstanceService(
  rpcUrl,
  dryRun ? undefined : safeSignerPrivateKey,
  dryRun ? undefined : safeAddress
);
// Track the next block to scan purely in memory between loop iterations.
let nextFromBlock = deployedAtBlock;

async function gracefulShutdown(signal: string) {
  try {
    await leaderElection?.stop();
  } catch (err) {
    rootLogger.warn("Failed to stop leader election:", err);
  }
  try {
    await slackService.notifySlackStartOrCrash(`🔄 *Backers Group TMS Service Shutting Down*\n\nService received ${signal} signal. Graceful shutdown initiated.`, SlackSeverity.INFO);
  } catch (error) {
    rootLogger.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

process.on('uncaughtException', async (err) => {
  rootLogger.error("Uncaught exception:", formatErrorWithCauses(err instanceof Error ? err : new Error(String(err))));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *crc-backers* Uncaught exception: ${err?.message || err}`, SlackSeverity.CRITICAL);
  } catch {}
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(error));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *crc-backers* Unhandled rejection: ${error.message}`, SlackSeverity.CRITICAL);
  } catch {}
  process.exit(1);
});

async function sendStartupNotification(): Promise<void> {
  const startupMessage = `✅ *Backers Group TMS Service Started*\n\n` +
    `Service is now running and monitoring for new backers.\n` +
    `- RPC: ${rpcUrl}\n` +
    `- Group: ${backersGroupAddress}\n` +
    `- Factory: ${backingFactoryAddress}\n` +
    `- Safe: ${safeAddress || "(not set)"}\n` +
    `- Safe signer configured: ${safeSignerPrivateKey.trim().length > 0}\n` +
    `- Dry Run: ${dryRun}\n` +
    `- Start Block: ${deployedAtBlock}\n` +
    `- Error Threshold: ${errorsBeforeCrash}`;

  try {
    await slackService.notifySlackStartOrCrash(startupMessage, SlackSeverity.INFO);
    rootLogger.info("Slack startup notification sent successfully.");
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack startup notification:", slackError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loop(leaderElection: LeaderElection | null) {
  const pollIntervalMs = 60 * 1000;
  const maxDelay = Math.min(pollIntervalMs * 4, 15 * 60 * 1000); // cap at 15 min
  let currentDelay = pollIntervalMs;

  // Attempt to restore scan cursor from PG
  const stateStore = process.env.LEADER_DB_URL ? new StateStore(process.env.LEADER_DB_URL) : null;
  if (stateStore) {
    const persisted = await stateStore.load("crc-backers");
    if (persisted) {
      nextFromBlock = persisted.lastScannedBlock;
      rootLogger.info(`[state-store] Restored scan cursor: nextFromBlock=${nextFromBlock}`);
    }
  }

  while (true) {
    const runStartedAt = Date.now();
    const effectiveDryRun = getEffectiveDryRun(leaderElection, dryRun);
    try {
      const isHealthy = await ensureRpcHealthyOrNotify({
        appName: "crc-backers",
        rpcUrl,
        logger: rootLogger
      });
      if (!isHealthy) { await delay(currentDelay); continue; }

      rootLogger.info("Checking for new backers...");
      await refreshBlacklist();

      const logger = rootLogger.child("process");
      const outcome = await runOnce(
        {
          circlesRpc,
          chainRpc,
          blacklistingService,
          groupService,
          cowSwapService,
          slackService,
          logger: logger
        },
        {
          backingFactoryAddress,
          backersGroupAddress,
          fromBlock: nextFromBlock,
          expectedTimeTillCompletion,
          confirmationBlocks,
          dryRun: effectiveDryRun
        }
      );
      nextFromBlock = outcome.nextFromBlock;
      await stateStore?.save("crc-backers", nextFromBlock);
      recordRunSuccess("crc-backers", Date.now() - runStartedAt);
      errorTracker.recordSuccess();
      currentDelay = pollIntervalMs; // reset on success
    } catch (caught: unknown) {
      const isError = caught instanceof Error;
      const baseError = isError ? caught : new Error(String(caught));

      const wrapped = new Error("runOnce failed in loop()", {cause: baseError});
      const consecutiveErrors = errorTracker.recordError();
      recordRunError("crc-backers");

      rootLogger.error(`Consecutive error ${consecutiveErrors} of ${errorsBeforeCrash}`);
      rootLogger.error(formatErrorWithCauses(wrapped));

      if (errorTracker.shouldAlert()) {
        rootLogger.error("Consecutive error threshold reached. Exiting with code 1.");
        void slackService.notifySlackStartOrCrash(
          `🚨 *crc-backers* crashing after ${consecutiveErrors} consecutive failures.\nLast error: ${baseError.message}`,
          SlackSeverity.CRITICAL
        ).catch(() => {});
        setTimeout(() => process.exit(1), 3000).unref();
        return;
      }
      currentDelay = Math.min(currentDelay * 2, maxDelay); // backoff on error
    }

    await delay(currentDelay);
  }
}

async function refreshBlacklist(): Promise<void> {
  try {
    rootLogger.info("Refreshing blacklist from remote service...");
    await blacklistingService.loadBlacklist();
    const count = blacklistingService.getBlacklistCount();
    rootLogger.info(`Blacklist refreshed successfully. ${count} addresses blacklisted.`);
  } catch (error) {
    rootLogger.error("Failed to refresh blacklist:", error);
    throw error;
  }
}

async function main() {
  startMetricsServer("crc-backers");
  leaderElection = await LeaderElection.create(
    process.env.LEADER_DB_URL,
    process.env.INSTANCE_ID,
    rootLogger.child("leader-election"),
    slackService,
    (isLeader) => setLeaderStatus("crc-backers", isLeader)
  );
  await sendStartupNotification();
  await loop(leaderElection);
}

main().catch(async (err) => {
  const asError = err instanceof Error ? err : new Error(String(err));
  rootLogger.error("Fatal error in crc-backers main():");
  rootLogger.error(formatErrorWithCauses(asError));

  try {
    const crashMessage = `🚨 *Backers Group TMS Service is CRASHING*\n\n` +
      `Fatal error in main(): ${asError.message}\n\n` +
      `Service will exit with code 1. Please investigate and restart.`;
    await slackService.notifySlackStartOrCrash(crashMessage, SlackSeverity.CRITICAL);
  } catch (slackError) {
    rootLogger.error("Failed to send Slack crash notification:", slackError);
  }

  process.exit(1);
});
