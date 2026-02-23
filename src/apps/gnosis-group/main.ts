import {LoggerService} from "../../services/loggerService";
import {BlacklistingService} from "../../services/blacklistingService";
import {CirclesRpcService} from "../../services/circlesRpcService";
import {IGroupService} from "../../interfaces/IGroupService";
import {SafeGroupService} from "../../services/safeGroupService";
import {SlackService} from "../../services/slackService";
import {
  runOnce,
  RunConfig,
  ScoreCache,
  DEFAULT_FETCH_PAGE_SIZE,
  DEFAULT_SCORE_BATCH_SIZE,
  DEFAULT_SCORE_THRESHOLD,
  DEFAULT_GROUP_BATCH_SIZE,
  DEFAULT_BACKERS_GROUP_ADDRESS,
  DEFAULT_AUTO_TRUST_GROUP_ADDRESSES,
  DEFAULT_SCORE_CACHE_TTL_MS,
  RunOutcome
} from "./logic";
import {formatErrorWithCauses} from "../../formatError";
import {startMetricsServer, recordRunSuccess, recordRunError} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const rootLogger = new LoggerService(verboseLogging, "gnosis-group");

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const blacklistingServiceUrl = process.env.BLACKLISTING_SERVICE_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist";
const scoringServiceUrl = process.env.GNOSIS_GROUP_SCORING_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/scoring/relative_trustscore/batch";
const targetGroupAddress = process.env.GNOSIS_GROUP_ADDRESS || "0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c";
const backersGroupAddress = process.env.GNOSIS_GROUP_BACKERS_GROUP_ADDRESS || DEFAULT_BACKERS_GROUP_ADDRESS;
const safeAddress = process.env.GNOSIS_GROUP_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.GNOSIS_GROUP_SAFE_SIGNER_PRIVATE_KEY || "";
const dryRun = process.env.DRY_RUN === "1";
const slackWebhookUrl = process.env.GNOSIS_GROUP_SLACK_WEBHOOK_URL || "";
const runIntervalMinutes = Math.max(1, parseEnvInt("GNOSIS_GROUP_RUN_INTERVAL_MINUTES", 30));
const runIntervalMs = runIntervalMinutes * 60 * 1_000;

if (!targetGroupAddress) {
  throw new Error("GNOSIS_GROUP_ADDRESS is required");
}

const fetchPageSize = parseEnvInt("GNOSIS_GROUP_FETCH_PAGE_SIZE", DEFAULT_FETCH_PAGE_SIZE);
const scoreBatchSize = parseEnvInt("GNOSIS_GROUP_SCORE_BATCH_SIZE", DEFAULT_SCORE_BATCH_SIZE);
const scoreThreshold = parseEnvNumber("GNOSIS_GROUP_SCORE_THRESHOLD", DEFAULT_SCORE_THRESHOLD);
const groupBatchSize = parseEnvInt("GNOSIS_GROUP_BATCH_SIZE", DEFAULT_GROUP_BATCH_SIZE);
const scoreCacheTtlMs = parseEnvInt("GNOSIS_GROUP_SCORE_CACHE_TTL_MINUTES", DEFAULT_SCORE_CACHE_TTL_MS / 60_000) * 60_000;

const blacklistingService = new BlacklistingService(blacklistingServiceUrl);
const circlesRpc = new CirclesRpcService(rpcUrl);
const slackService = new SlackService(slackWebhookUrl);
const slackConfigured = slackWebhookUrl.trim().length > 0;
const scoreCache = new ScoreCache();
const errorTracker = new ConsecutiveErrorTracker(3);

const runLogger = rootLogger.child("run");
let groupService: IGroupService | undefined;

if (!dryRun && safeSignerPrivateKey.trim().length === 0) {
  throw new Error("GNOSIS_GROUP_SAFE_SIGNER_PRIVATE_KEY is required when not running gnosis-group in dry-run mode");
}

if (!dryRun && safeAddress.trim().length === 0) {
  throw new Error("GNOSIS_GROUP_SAFE_ADDRESS is required when not running gnosis-group in dry-run mode");
}

if (!dryRun) {
  groupService = new SafeGroupService(rpcUrl, safeSignerPrivateKey, safeAddress);
}

const config: RunConfig = {
  rpcUrl,
  scoringServiceUrl,
  targetGroupAddress,
  backersGroupAddress,
  fetchPageSize,
  scoreBatchSize,
  scoreThreshold,
  groupBatchSize,
  scoreCacheTtlMs,
  dryRun
};

rootLogger.info("Starting gnosis-group run with config:");
rootLogger.info(`  - rpcUrl=${rpcUrl}`);
rootLogger.info(`  - scoringServiceUrl=${scoringServiceUrl}`);
rootLogger.info(`  - targetGroupAddress=${targetGroupAddress}`);
rootLogger.info(`  - backersGroupAddress=${backersGroupAddress}`);
rootLogger.info(`  - fetchPageSize=${fetchPageSize}`);
rootLogger.info(`  - scoreBatchSize=${scoreBatchSize}`);
rootLogger.info(`  - scoreThreshold=${scoreThreshold}`);
rootLogger.info(`  - groupBatchSize=${groupBatchSize}`);
rootLogger.info(`  - defaultAutoTrustGroupAddresses=${DEFAULT_AUTO_TRUST_GROUP_ADDRESSES.join(",")}`);
rootLogger.info(`  - safeAddress=${safeAddress || "(not set)"}`);
rootLogger.info(`  - safeSignerPrivateKeyConfigured=${safeSignerPrivateKey.trim().length > 0}`);
rootLogger.info(`  - dryRun=${dryRun}`);
rootLogger.info(`  - runIntervalMinutes=${runIntervalMinutes}`);
rootLogger.info(`  - scoreCacheTtlMinutes=${scoreCacheTtlMs / 60_000}`);
rootLogger.info(`  - slackConfigured=${slackConfigured}`);

void notifySlackStartup();

process.on("SIGINT", async () => {
  await notifySlackShutdown("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await notifySlackShutdown("SIGTERM");
  process.exit(0);
});

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
  while (true) {
    const runStartedAt = Date.now();
    try {
      await ensureRpcHealthyOrNotify({
        appName: "gnosis-group",
        rpcUrl,
        slackService,
        logger: rootLogger
      });
      await refreshBlacklist();
      const outcome = await runOnce(
        {
          blacklistingService,
          circlesRpc,
          groupService,
          logger: runLogger,
          scoreCache
        },
        config
      );

      recordRunSuccess("gnosis-group", Date.now() - runStartedAt);
      errorTracker.recordSuccess();
      rootLogger.info(
        `Run completed. Addresses with relative score > ${outcome.threshold}: ${outcome.aboveThresholdCount}`
      );
      await notifySlackRunSummary(outcome);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError("gnosis-group");
      rootLogger.error("gnosis-group run failed:");
      rootLogger.error(formatErrorWithCauses(error));
      if (errorTracker.shouldAlert()) {
        await notifySlackRunError(error, consecutiveErrors);
      }
    }

    const elapsedMs = Date.now() - runStartedAt;
    const waitMs = Math.max(0, runIntervalMs - elapsedMs);
    if (waitMs > 0) {
      rootLogger.info(`Waiting ${(waitMs / 60_000).toFixed(1)} minute(s) before the next run.`);
      await delay(waitMs);
    } else {
      rootLogger.info("Run interval elapsed; starting next run immediately.");
    }
  }
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
    runLogger.error("Failed to refresh blacklist:", error);
    throw error;
  }
}

async function start(): Promise<void> {
  await mainLoop();
}

start().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("gnosis-group run encountered an unrecoverable error:");
  rootLogger.error(formatErrorWithCauses(error));
  void notifySlackFatal(error);
  process.exitCode = 1;
});

async function notifySlackStartup(): Promise<void> {
  const header = dryRun
    ? "🧪 *Gnosis Group Service Started (dry-run)*"
    : "✅ *Gnosis Group Service Started*";
  const message =
    `${header}\n\n` +
    `- RPC: ${rpcUrl}\n` +
    `- Scoring Service: ${scoringServiceUrl}\n` +
    `- Gnosis Group: ${targetGroupAddress}\n` +
    `- Score Threshold: ${scoreThreshold}\n` +
    `- Run Interval (min): ${runIntervalMinutes}\n` +
    `- Slack Configured: ${slackConfigured}`;

  try {
    await slackService.notifySlackStartOrCrash(message);
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
    await slackService.notifySlackStartOrCrash(`🔄 *Gnosis Group Service shutting down*\n\nReceived ${signal}.`);
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
    await slackService.notifySlackStartOrCrash(lines.join("\n"));
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
    await slackService.notifySlackStartOrCrash(message);
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
    await slackService.notifySlackStartOrCrash(message);
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
