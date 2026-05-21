import {LoggerService} from "../../services/loggerService";
import {BlacklistingService} from "../../services/blacklistingService";
import {CirclesRpcService} from "../../services/circlesRpcService";
import {IGroupService} from "../../interfaces/IGroupService";
import {SafeGroupService} from "../../services/safeGroupService";
import {SlackService} from "../../services/slackService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {
  runOnce,
  RunConfig,
  ScoreCache,
  DEFAULT_FETCH_PAGE_SIZE,
  DEFAULT_SCORE_BATCH_SIZE,
  DEFAULT_SCORE_FETCH_TIMEOUT_MS,
  DEFAULT_SCORE_THRESHOLD,
  DEFAULT_GROUP_BATCH_SIZE,
  FIXED_AUTO_TRUST_GROUP_ADDRESSES,
  HISTORIC_AUTO_TRUST_GROUP_ADDRESS,
  HISTORIC_AUTO_TRUST_GROUP_BLOCK_NUMBER,
  DEFAULT_SCORE_CACHE_TTL_MS,
  DEFAULT_SCORING_TARGET_SET_NAME,
  RunOutcome
} from "./logic";
import {formatErrorWithCauses} from "../../formatError";
import {startMetricsServer, recordRunSuccess, recordRunError} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {StateStore} from "../../services/stateStore";
import {resolveTransactionRpcUrl} from "../../services/transactionRpc";

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const rootLogger = new LoggerService(verboseLogging, "gnosis-group");

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const blacklistingServiceUrl = process.env.BLACKLISTING_SERVICE_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist";
const scoringServiceUrl = process.env.GNOSIS_GROUP_SCORING_URL || "https://safe-watch-api-prod.ai.gnosisdev.com/validate-trustees";
const targetGroupAddress = process.env.GNOSIS_GROUP_ADDRESS || "0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c";
const safeAddress = process.env.GNOSIS_GROUP_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.GNOSIS_GROUP_SAFE_SIGNER_PRIVATE_KEY || "";
const dryRun = process.env.DRY_RUN === "1";
const slackWebhookUrl = process.env.GNOSIS_GROUP_SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";
const runIntervalMinutes = Math.max(1, parseEnvInt("GNOSIS_GROUP_RUN_INTERVAL_MINUTES", 30));
const runIntervalMs = runIntervalMinutes * 60 * 1_000;

if (!targetGroupAddress) {
  throw new Error("GNOSIS_GROUP_ADDRESS is required");
}

const fetchPageSize = parseEnvInt("GNOSIS_GROUP_FETCH_PAGE_SIZE", DEFAULT_FETCH_PAGE_SIZE);
const scoreBatchSize = parseEnvInt("GNOSIS_GROUP_SCORE_BATCH_SIZE", DEFAULT_SCORE_BATCH_SIZE);
const scoreFetchTimeoutMs = Math.max(1000, parseEnvInt("GNOSIS_GROUP_SCORE_FETCH_TIMEOUT_MS", DEFAULT_SCORE_FETCH_TIMEOUT_MS));
const scoreThreshold = parseEnvNumber("GNOSIS_GROUP_SCORE_THRESHOLD", DEFAULT_SCORE_THRESHOLD);
const groupBatchSize = parseEnvInt("GNOSIS_GROUP_BATCH_SIZE", DEFAULT_GROUP_BATCH_SIZE);
const scoreCacheTtlMs = parseEnvInt("GNOSIS_GROUP_SCORE_CACHE_TTL_MINUTES", DEFAULT_SCORE_CACHE_TTL_MS / 60_000) * 60_000;
const scoringTargetSetName = process.env.GNOSIS_GROUP_SCORING_TARGET_SET_NAME || DEFAULT_SCORING_TARGET_SET_NAME;

const blacklistTimeoutMs = (() => {
  const raw = process.env.BLACKLIST_TIMEOUT_MS;
  if (!raw) return 60_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) { console.warn(`[config] Invalid BLACKLIST_TIMEOUT_MS="${raw}", using default 60000`); return 60_000; }
  return parsed;
})();
const blacklistingService = new BlacklistingService(blacklistingServiceUrl, blacklistTimeoutMs);
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const circlesRpc = new CirclesRpcService(rpcUrl, (msg) => {
  console.warn(`[CirclesRpc] ${msg}`);
  void slackService.notifySlackStartOrCrash(`⚠️ *gnosis-group* pagination cap: ${msg}`, SlackSeverity.WARNING).catch((e) => console.warn("[SlackAlert] failed:", (e as Error).message));
});
const slackConfigured = slackWebhookUrl.trim().length > 0;
const scoreCache = new ScoreCache();
const errorsBeforeCrash = 3;
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
const canSimulateTransactions = safeSignerPrivateKey.trim().length > 0 && safeAddress.trim().length > 0;

const runLogger = rootLogger.child("run");
let groupService: IGroupService | undefined;

if (!dryRun && safeSignerPrivateKey.trim().length === 0) {
  throw new Error("GNOSIS_GROUP_SAFE_SIGNER_PRIVATE_KEY is required when not running gnosis-group in dry-run mode");
}

if (!dryRun && safeAddress.trim().length === 0) {
  throw new Error("GNOSIS_GROUP_SAFE_ADDRESS is required when not running gnosis-group in dry-run mode");
}

if (!dryRun || canSimulateTransactions) {
  groupService = new SafeGroupService(rpcUrl, safeSignerPrivateKey, safeAddress, txRpcUrl);
}

const config: RunConfig = {
  rpcUrl,
  scoringServiceUrl,
  scoringTargetSetName,
  targetGroupAddress,
  fetchPageSize,
  scoreBatchSize,
  scoreFetchTimeoutMs,
  scoreThreshold,
  groupBatchSize,
  scoreCacheTtlMs,
  dryRun
};

rootLogger.info("Starting gnosis-group run with config:");
rootLogger.info(`  - rpcUrl=${rpcUrl}`);
rootLogger.info(`  - txRpcUrl=${txRpcUrl}`);
rootLogger.info(`  - scoringServiceUrl=${scoringServiceUrl}`);
rootLogger.info(`  - scoringTargetSetName=${scoringTargetSetName}`);
rootLogger.info(`  - targetGroupAddress=${targetGroupAddress}`);
rootLogger.info(`  - fetchPageSize=${fetchPageSize}`);
rootLogger.info(`  - scoreBatchSize=${scoreBatchSize}`);
rootLogger.info(`  - scoreFetchTimeoutMs=${scoreFetchTimeoutMs}`);
rootLogger.info(`  - scoreThreshold=${scoreThreshold}`);
rootLogger.info(`  - groupBatchSize=${groupBatchSize}`);
rootLogger.info(`  - fixedAutoTrustGroupAddresses=${FIXED_AUTO_TRUST_GROUP_ADDRESSES.join(",")}`);
rootLogger.info(`  - historicAutoTrustGroupAddress=${HISTORIC_AUTO_TRUST_GROUP_ADDRESS}`);
rootLogger.info(`  - historicAutoTrustGroupBlockNumber=${HISTORIC_AUTO_TRUST_GROUP_BLOCK_NUMBER}`);
rootLogger.info(`  - safeAddress=${safeAddress || "(not set)"}`);
rootLogger.info(`  - safeSignerPrivateKeyConfigured=${safeSignerPrivateKey.trim().length > 0}`);
rootLogger.info(`  - dryRunSimulationConfigured=${canSimulateTransactions}`);
rootLogger.info(`  - dryRun=${dryRun}`);
rootLogger.info(`  - runIntervalMinutes=${runIntervalMinutes}`);
rootLogger.info(`  - scoreCacheTtlMinutes=${scoreCacheTtlMs / 60_000}`);
rootLogger.info(`  - slackConfigured=${slackConfigured}`);

void notifySlackStartup();

async function gracefulShutdown(signal: NodeJS.Signals) {
  await notifySlackShutdown(signal);
  process.exit(0);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

process.on("uncaughtException", async (error) => {
  rootLogger.error("Uncaught exception:", formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
  await notifySlackFatal(error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(error));
  await notifySlackFatal(error);
  process.exit(1);
});

async function mainLoop(): Promise<void> {
  startMetricsServer("gnosis-group");
  const maxDelay = Math.min(runIntervalMs * 4, 15 * 60 * 1000); // cap at 15 min
  let currentDelay = runIntervalMs;
  const stateStore = process.env.LEADER_DB_URL ? new StateStore(process.env.LEADER_DB_URL) : null;
  let historicAutoTrustSnapshotMembers: string[] | null = null;

  while (true) {
    const runStartedAt = Date.now();
    try {
      const isHealthy = await ensureRpcHealthyOrNotify({
        appName: "gnosis-group",
        rpcUrl,
        logger: rootLogger
      });
      if (!isHealthy) { await delay(currentDelay); continue; }
      if (historicAutoTrustSnapshotMembers === null) {
        historicAutoTrustSnapshotMembers = await loadHistoricAutoTrustSnapshotMembers();
      }
      await refreshBlacklist();
      const outcome = await runOnce(
        {
          blacklistingService,
          circlesRpc,
          groupService,
          logger: runLogger,
          scoreCache
        },
        {
          ...config,
          historicAutoTrustSnapshotMembers
        }
      );

      await stateStore?.save("gnosis-group", 0, { lastSuccessfulRunAt: new Date().toISOString() });
      recordRunSuccess("gnosis-group", Date.now() - runStartedAt);
      errorTracker.recordSuccess();
      if (errorTracker.wasAlertingAndRecovered()) {
        slackService.notifySlackResolved("Gnosis Group").catch((err) => {
          rootLogger.warn("Failed to send Slack resolved notification:", err);
        });
      }
      currentDelay = runIntervalMs;
      rootLogger.info(
        `Run completed. Addresses with gnosis trust score > ${outcome.threshold}: ${outcome.aboveThresholdCount}`
      );
      await notifySlackRunSummary(outcome);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError("gnosis-group");
      rootLogger.error(`Consecutive error ${consecutiveErrors} of ${errorsBeforeCrash}`);
      rootLogger.error(formatErrorWithCauses(error));
      if (errorTracker.shouldAlert()) {
        rootLogger.error("Consecutive error threshold reached. Exiting with code 1.");
        void notifySlackRunError(error, consecutiveErrors).catch((e) => rootLogger.warn("Failed to send Slack notification:", e));
        setTimeout(() => process.exit(1), 3000).unref();
        return;
      }
      currentDelay = Math.min(currentDelay * 2, maxDelay);
    }

    const elapsedMs = Date.now() - runStartedAt;
    const waitMs = Math.max(0, currentDelay - elapsedMs);
    if (waitMs > 0) {
      rootLogger.info(`Waiting ${(waitMs / 60_000).toFixed(1)} minute(s) before the next run.`);
      await delay(waitMs);
    } else {
      rootLogger.info("Run interval elapsed; starting next run immediately.");
    }
  }
}

async function loadHistoricAutoTrustSnapshotMembers(): Promise<string[]> {
  runLogger.info(
    `Loading historical auto-trust snapshot ${HISTORIC_AUTO_TRUST_GROUP_ADDRESS}@${HISTORIC_AUTO_TRUST_GROUP_BLOCK_NUMBER}.`
  );
  const members = await circlesRpc.fetchActiveGroupMembersAtBlock(
    HISTORIC_AUTO_TRUST_GROUP_ADDRESS,
    HISTORIC_AUTO_TRUST_GROUP_BLOCK_NUMBER
  );
  runLogger.info(
    `Loaded ${members.length} historical auto-trust snapshot member(s) from ${HISTORIC_AUTO_TRUST_GROUP_ADDRESS}@${HISTORIC_AUTO_TRUST_GROUP_BLOCK_NUMBER}.`
  );
  return members;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    rootLogger.warn(`Invalid integer for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }

  return parsed;
}

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    rootLogger.warn(`Invalid number for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }

  return parsed;
}

async function refreshBlacklist(): Promise<void> {
  try {
    runLogger.info("Refreshing blacklist from remote service...");
    await blacklistingService.loadBlacklist();
    const count = blacklistingService.getBlacklistCount();
    runLogger.info(`Blacklist refreshed successfully. ${count} addresses blacklisted.`);
  } catch (error) {
    if (blacklistingService.isLoaded()) {
      const staleCount = blacklistingService.getBlacklistCount();
      runLogger.warn(
        `Failed to refresh blacklist (${(error as Error).message}). ` +
        `Proceeding with stale blacklist data (${staleCount} addresses).`
      );
      return;
    }
    runLogger.error("Failed to refresh blacklist on initial load:", error);
    throw error;
  }
}

async function start(): Promise<void> {
  if (groupService?.validateSafeOwnership) {
    try {
      await groupService.validateSafeOwnership();
      rootLogger.info("Safe ownership validation passed — signer is a registered owner.");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      rootLogger.error(`Safe ownership validation FAILED: ${errorMessage}`);
      try {
        await slackService.notifySlackStartOrCrash(
          `🚨 *gnosis-group Safe ownership check failed*\n\n${errorMessage}`,
          SlackSeverity.CRITICAL
        );
      } catch (slackErr) {
        rootLogger.warn("Failed to send Slack ownership failure notification:", slackErr);
      }
      process.exit(1);
    }
  }
  await mainLoop();
}

start().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("gnosis-group run encountered an unrecoverable error:");
  rootLogger.error(formatErrorWithCauses(error));
  void notifySlackFatal(error).catch((e) => rootLogger.warn("Failed to send Slack notification:", e));
  setTimeout(() => process.exit(1), 3000).unref();
});

async function notifySlackStartup(): Promise<void> {
  const header = dryRun
    ? "🧪 *Gnosis Group Service Started (dry-run)*"
    : "✅ *Gnosis Group Service Started*";
  const message =
    `${header}\n\n` +
    `- RPC: ${rpcUrl}\n` +
    `- TX RPC: ${txRpcUrl}\n` +
    `- Scoring Service: ${scoringServiceUrl}\n` +
    `- Gnosis Group: ${targetGroupAddress}\n` +
    `- Score Threshold: ${scoreThreshold}\n` +
    `- Run Interval (min): ${runIntervalMinutes}\n` +
    `- Slack Configured: ${slackConfigured}`;

  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.INFO);
    if (slackConfigured) {
      rootLogger.info("Slack startup notification sent.");
    } else {
      rootLogger.info("Slack startup notification skipped (no webhook configured).");
    }
  } catch (error) {
    rootLogger.warn("Failed to send Slack startup notification:", error);
  }
}

async function notifySlackShutdown(signal: NodeJS.Signals): Promise<void> {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 *Gnosis Group Service shutting down*\n\nReceived ${signal}.`, SlackSeverity.INFO);
  } catch (error) {
    rootLogger.warn("Failed to send Slack shutdown notification:", error);
  }
}

async function notifySlackRunSummary(outcome: RunOutcome): Promise<void> {
  const hasExecutedTx = outcome.trustTxHashes.length > 0 || outcome.untrustTxHashes.length > 0;
  const hasPlannedChanges = dryRun && (outcome.addressesQueuedForTrust.length > 0 || outcome.addressesToUntrust.length > 0);

  if (!hasExecutedTx && !hasPlannedChanges) {
    return;
  }

  const header = dryRun
    ? "🧪 *Gnosis Group Dry-Run Summary*"
    : "✅ *Gnosis Group Run Summary*";

  const lines: string[] = [
    header,
    "",
    `- Target Group: ${outcome.targetGroupAddress}`,
    `- Mode: ${dryRun ? "Dry Run" : "Live"}`,
    `- Above Threshold (> ${outcome.threshold}): ${outcome.aboveThresholdCount}`,
    `- Allowed Avatars (post-blacklist): ${outcome.allowedAvatars.length}`,
    `- Auto-Trusted via configured groups: ${outcome.addressesAutoTrustedByGroups.length}`
  ];

  if (outcome.blacklistedAvatars.length > 0) {
    lines.push(`- Blacklisted this run: ${outcome.blacklistedAvatars.length}`);
  }

  const trustBullet = formatAddressBullet(dryRun ? "Would trust" : "Trusted", outcome.addressesQueuedForTrust, 10);
  if (trustBullet) {
    lines.push(trustBullet);
  }

  if (!dryRun && outcome.trustTxHashes.length > 0) {
    lines.push(formatTxBullet("Trust tx", outcome.trustTxHashes, 5));
  }

  const untrustBullet = formatAddressBullet(dryRun ? "Would untrust" : "Untrusted", outcome.addressesToUntrust, 10);
  if (untrustBullet) {
    lines.push(untrustBullet);
  }

  if (!dryRun && outcome.untrustTxHashes.length > 0) {
    lines.push(formatTxBullet("Untrust tx", outcome.untrustTxHashes, 5));
  }

  try {
    await slackService.notifySlackStartOrCrash(lines.join("\n"), SlackSeverity.INFO);
    if (slackConfigured) {
      rootLogger.info("Slack run summary notification sent.");
    }
  } catch (error) {
    rootLogger.warn("Failed to send Slack run summary notification:", error);
  }
}

async function notifySlackRunError(error: Error, consecutiveErrors: number): Promise<void> {
  const message = `⚠️ *Gnosis Group run failed* (${consecutiveErrors} consecutive failures)\n\n${formatErrorWithCauses(error)}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.WARNING);
    if (slackConfigured) {
      rootLogger.info("Slack run error notification sent.");
    }
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack run error notification:", slackError);
  }
}

async function notifySlackFatal(error: Error): Promise<void> {
  const message = `🚨 *Gnosis Group Service crashed*\n\n${error.message}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.CRITICAL);
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack fatal notification:", slackError);
  }
}

function formatAddressBullet(label: string, addresses: string[], limit: number): string {
  if (addresses.length === 0) {
    return "";
  }

  const shown = addresses.slice(0, limit);
  const remaining = addresses.length - shown.length;
  const suffix = remaining > 0 ? `, … (+${remaining} more)` : "";
  return `- ${label} (${addresses.length}): ${shown.join(", ")}${suffix}`;
}

function formatTxBullet(label: string, txHashes: string[], limit: number): string {
  if (txHashes.length === 0) {
    return "";
  }

  const shown = txHashes.slice(0, limit);
  const remaining = txHashes.length - shown.length;
  const suffix = remaining > 0 ? `, … (+${remaining} more)` : "";
  return `- ${label} hash(es): ${shown.join(", ")}${suffix}`;
}
