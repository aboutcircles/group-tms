import {runIncremental, type IncrementalState, createInitialIncrementalState} from "./logic";
import {CirclesRpcService} from "../../services/circlesRpcService";
import {ChainRpcService} from "../../services/chainRpcService";
import {GroupService} from "../../services/groupService";
import {AffiliateGroupEventsService} from "../../services/affiliateGroupEventsService";
import {SlackService} from "../../services/slackService";
import {LoggerService} from "../../services/loggerService";
import {IGroupService} from "../../interfaces/IGroupService";
import {startMetricsServer, recordRunSuccess, recordRunError} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {formatErrorWithCauses} from "../../formatError";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {Wallet} from "ethers";

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const oicGroupAddress = (process.env.OIC_GROUP_ADDRESS || "0x4E2564e5df6C1Fb10C1A018538de36E4D5844DE5").toLowerCase();
const metaOrgAddress = (process.env.OIC_META_ORG_ADDRESS || "").toLowerCase();
const affiliateRegistryAddress = (process.env.AFFILIATE_REGISTRY_ADDRESS || "0xca8222e780d046707083f51377b5fd85e2866014").toLowerCase();
const servicePrivateKey = process.env.OIC_SERVICE_PRIVATE_KEY || process.env.OIC_SAFE_SIGNER_PRIVATE_KEY || "";
const configuredServiceEoa = (process.env.OIC_SERVICE_EOA || "").toLowerCase();
const deployedAtBlock = 41_734_312;
const confirmationBlocks = Number.parseInt(process.env.CONFIRMATION_BLOCKS || "10");
const refreshIntervalSec = Number.parseInt(process.env.REFRESH_INTERVAL_SEC || "3600");
const dryRun = process.env.DRY_RUN === "1";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const outputBatchSize = 20;

const rootLogger = new LoggerService(verboseLogging);
const circlesRpc = new CirclesRpcService(rpcUrl);
const chainRpc = new ChainRpcService(rpcUrl);
let groupService: IGroupService;
const affiliateRegistry = new AffiliateGroupEventsService(rpcUrl, rootLogger.child("oic:affiliate-registry"));

const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackService = new SlackService(slackWebhookUrl);
const slackConfigured = !!slackWebhookUrl;
const errorTracker = new ConsecutiveErrorTracker(3);

validateConfig();

if (dryRun) {
  groupService = createDryRunGroupService();
} else {
  groupService = new GroupService(rpcUrl, servicePrivateKey);
}

function validateConfig() {
  if (!oicGroupAddress) throw new Error("OIC_GROUP_ADDRESS is required");
  if (!metaOrgAddress) throw new Error("OIC_META_ORG_ADDRESS is required");
  if (!servicePrivateKey && !dryRun) throw new Error("OIC_SERVICE_PRIVATE_KEY is required when not in dry-run");
  if (configuredServiceEoa && !dryRun) {
    const signerAddress = new Wallet(servicePrivateKey).address.toLowerCase();
    if (signerAddress !== configuredServiceEoa) {
      throw new Error(
        `Configured OIC_SERVICE_EOA (${configuredServiceEoa}) does not match signer address (${signerAddress}).`
      );
    }
  }
}

function createDryRunGroupService(): IGroupService {
  const notAvailable = async () => {
    throw new Error("Group service is not available in dry-run mode");
  };
  return {
    trustBatchWithConditions: notAvailable,
    untrustBatch: notAvailable,
    fetchGroupOwnerAndService: notAvailable
  };
}

process.on('SIGTERM', async () => {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 *OIC Service Shutting Down*\n\nService received SIGTERM signal. Graceful shutdown initiated.`);
  } catch (error) {
    rootLogger.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 *OIC Service Shutting Down*\n\nService received SIGINT signal. Graceful shutdown initiated.`);
  } catch (error) {
    rootLogger.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  try {
    await slackService.notifySlackStartOrCrash(`💥 Uncaught exception: ${err?.message || err}`);
  } catch {}
  rootLogger.error(err);
  process.exit(1);
});

process.on('unhandledRejection', async (reason: any) => {
  try {
    await slackService.notifySlackStartOrCrash(`💥 Unhandled rejection: ${reason?.message || String(reason)}`);
  } catch {}
  rootLogger.error(reason);
  process.exit(1);
});

// Send startup notification
(async () => {
  try {
    validateConfig();
    const startupMessage = `✅ *OIC Service Started*\n\n` +
      `Service is now running and monitoring + reconciling trust.\n` +
      `- RPC: ${rpcUrl}\n` +
      `- Group: ${oicGroupAddress}\n` +
      `- MetaOrg: ${metaOrgAddress}\n` +
      `- AffiliateRegistry: ${affiliateRegistryAddress}\n` +
      `- Service EOA: ${configuredServiceEoa || "(not set)"}\n` +
      `- Service key configured: ${servicePrivateKey.trim().length > 0}\n` +
      `- Start Block: ${deployedAtBlock}\n` +
      `- Confirmations: ${confirmationBlocks}\n` +
      `- Refresh (s): ${refreshIntervalSec}\n` +
      `- DryRun: ${dryRun}`;

    await slackService.notifySlackStartOrCrash(startupMessage);
    if (slackConfigured) {
      rootLogger.info("Slack startup notification sent successfully.");
    } else {
      rootLogger.info("Slack startup notification skipped (no webhook configured).");
    }
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack startup notification:", slackError);
  }
})();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  startMetricsServer("oic");
  const state: IncrementalState = createInitialIncrementalState();
  state.lastSafeHeadScanned = Math.max(0, deployedAtBlock - 1);
  // Only print startup/info logs once per process lifetime
  let printedStartupLogs = false;
  while (true) {
    const runStartedAt = Date.now();
    try {
      const LOG = rootLogger.child("oic");
      const isHealthy = await ensureRpcHealthyOrNotify({
        appName: "oic",
        rpcUrl,
        logger: rootLogger
      });
      if (!isHealthy) { await delay(refreshIntervalSec * 1000); continue; }

      if (!printedStartupLogs) {
        LOG.info("OIC app starting (monitor + reconcile trust)...");
        // Reduce noise: print config details only in verbose mode
        LOG.debug(`RPC: ${rpcUrl}`);
        LOG.debug(`Group: ${oicGroupAddress}`);
        LOG.debug(`MetaOrg: ${metaOrgAddress}`);
        LOG.debug(`AffiliateRegistry: ${affiliateRegistryAddress}`);
        LOG.debug(`Service EOA: ${configuredServiceEoa || "(not set)"}`);
        LOG.debug(`DryRun: ${dryRun}`);
        printedStartupLogs = true;
      }

      await runIncremental(
        { circlesRpc, chainRpc, groupService, affiliateRegistry, logger: LOG },
        {
          confirmationBlocks,
          groupAddress: oicGroupAddress,
          metaOrgAddress,
          affiliateRegistryAddress,
          outputBatchSize,
          deployedAtBlock,
          dryRun,
        },
        state,
      );
      recordRunSuccess("oic", Date.now() - runStartedAt);
      errorTracker.recordSuccess();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError("oic");
      rootLogger.error("OIC runOnce failed:");
      rootLogger.error(formatErrorWithCauses(error));
      if (errorTracker.shouldAlert()) {
        void notifySlackRunError(error, consecutiveErrors);
      }
    }

    await delay(refreshIntervalSec * 1000);
  }
}

async function notifySlackRunError(error: Error, consecutiveErrors: number): Promise<void> {
  const message = `⚠️ *OIC Service runOnce error* (${consecutiveErrors} consecutive failures)\n\n${formatErrorWithCauses(error)}`;
  try {
    await slackService.notifySlackStartOrCrash(message);
  } catch (slackError) {
    rootLogger.warn("Failed to send run error notification to Slack:", slackError);
  }
}

(async () => {
  try {
    await loop();
  } catch (err) {
    rootLogger.error("Fatal error in OIC main:", err);
    process.exit(1);
  }
})();
