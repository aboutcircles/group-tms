import {BlacklistingService} from "../../services/blacklistingService";
import {LoggerService} from "../../services/loggerService";
import {SlackService} from "../../services/slackService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {MetriSafeService} from "../../services/metriSafeService";
import {InMemoryAvatarSafeMappingStore} from "../../services/inMemoryAvatarSafeMappingStore";
import {CirclesRpcService} from "../../services/circlesRpcService";
import {SafeGroupService} from "../../services/safeGroupService";
import {IGroupService} from "../../interfaces/IGroupService";
import {
  runOnce,
  RunConfig,
  DEFAULT_FETCH_PAGE_SIZE,
  DEFAULT_GROUP_BATCH_SIZE
} from "./logic";
import {formatErrorWithCauses} from "../../formatError";
import {startMetricsServer, recordRunSuccess, recordRunError, setLeaderStatus} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {LeaderElection, getEffectiveDryRun} from "../../services/leaderElection";
import {StateStore} from "../../services/stateStore";

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const rootLogger = new LoggerService(verboseLogging, "gp-crc");

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const blacklistingServiceUrl = process.env.BLACKLISTING_SERVICE_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist";
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";
const groupAddress = process.env.GP_CRC_GROUP_ADDRESS || "0xb629a1e86f3efada0f87c83494da8cc34c3f84ef";
const safeAddress = process.env.GP_CRC_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.GP_CRC_SAFE_SIGNER_PRIVATE_KEY || "";
const dryRun = process.env.DRY_RUN === "1";
const metriSafeGraphqlUrl = process.env.METRI_SAFE_GRAPHQL_URL || "https://gnosis-e702590.dedicated.hyperindex.xyz/v1/graphql" ;
const metriSafeApiKey = process.env.METRI_SAFE_API_KEY || "";

const fetchPageSize = parseEnvInt("GP_CRC_FETCH_PAGE_SIZE", DEFAULT_FETCH_PAGE_SIZE);
const pollIntervalMs = 10 * 60 * 1_000;
const groupBatchSize = DEFAULT_GROUP_BATCH_SIZE;
const errorsBeforeCrash = 3;
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
let leaderElection: LeaderElection | null = null;

const circlesRpc = new CirclesRpcService(rpcUrl);
const blacklistingService = new BlacklistingService(blacklistingServiceUrl);
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const slackConfigured = slackWebhookUrl.trim().length > 0;
let groupService: IGroupService | undefined;
let avatarSafeService: MetriSafeService;

if (!groupAddress) {
  throw new Error("GP_CRC_GROUP_ADDRESS is required");
}

if (!metriSafeGraphqlUrl) {
  throw new Error("METRI_SAFE_GRAPHQL_URL is required");
}

avatarSafeService = new MetriSafeService(metriSafeGraphqlUrl, metriSafeApiKey || undefined);

const avatarSafeMappingStore = new InMemoryAvatarSafeMappingStore();

if (!dryRun && safeSignerPrivateKey.trim().length === 0) {
  throw new Error("GP_CRC_SAFE_SIGNER_PRIVATE_KEY is required when not running gp-crc in dry-run mode");
}

if (!dryRun && safeAddress.trim().length === 0) {
  throw new Error("GP_CRC_SAFE_ADDRESS is required when not running gp-crc in dry-run mode");
}

if (!dryRun) {
  groupService = new SafeGroupService(rpcUrl, safeSignerPrivateKey, safeAddress);
}

const runLogger = rootLogger.child("run");

const config: RunConfig = {
  rpcUrl,
  fetchPageSize,
  groupAddress,
  dryRun,
  groupBatchSize
};

rootLogger.info("Starting gp-crc watcher with config:");
rootLogger.info(`  - rpcUrl=${rpcUrl}`);
rootLogger.info(`  - fetchPageSize=${fetchPageSize}`);
rootLogger.info(`  - pollIntervalMs=${pollIntervalMs}`);
rootLogger.info(`  - groupAddress=${groupAddress}`);
rootLogger.info(`  - groupBatchSize=${groupBatchSize}`);
rootLogger.info(`  - metriSafeGraphqlUrl=${metriSafeGraphqlUrl}`);
rootLogger.info(`  - safeAddress=${safeAddress || "(not set)"}`);
rootLogger.info(`  - safeSignerConfigured=${safeSignerPrivateKey.trim().length > 0}`);
rootLogger.info(`  - dryRun=${dryRun}`);

void notifySlackStartup();

async function gracefulShutdown(signal: string) {
  try {
    await leaderElection?.stop();
  } catch (err) {
    rootLogger.warn("Failed to stop leader election:", err);
  }
  try {
    await slackService.notifySlackStartOrCrash(`🔄 *GP-CRC TMS Service shutting down*\n\nService received ${signal} signal. Graceful shutdown initiated.`, SlackSeverity.INFO);
  } catch (error) {
    rootLogger.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

process.on("uncaughtException", async (error) => {
  rootLogger.error("Uncaught exception:", formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *gp-crc* Uncaught exception: ${error?.message || error}`, SlackSeverity.CRITICAL);
  } catch {}
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(error));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *gp-crc* Unhandled rejection: ${error.message}`, SlackSeverity.CRITICAL);
  } catch {}
  process.exit(1);
});

async function mainLoop(): Promise<void> {
  startMetricsServer("gp-crc");
  leaderElection = await LeaderElection.create(
    process.env.LEADER_DB_URL,
    process.env.INSTANCE_ID,
    slackService,
    (isLeader) => setLeaderStatus("gp-crc", isLeader)
  );
  const maxDelay = Math.min(pollIntervalMs * 4, 15 * 60 * 1000); // cap at 15 min
  let currentDelay = pollIntervalMs;
  const stateStore = process.env.LEADER_DB_URL ? new StateStore(process.env.LEADER_DB_URL) : null;

  while (true) {
    const runStartedAt = Date.now();
    const effectiveDryRun = getEffectiveDryRun(leaderElection, dryRun);
    try {
      const isHealthy = await ensureRpcHealthyOrNotify({
        appName: "gp-crc",
        rpcUrl,
        logger: rootLogger
      });
      if (!isHealthy) { await delay(currentDelay); continue; }
      await refreshBlacklist();
      const outcome = await runOnce(
        {
          blacklistingService,
          avatarSafeService,
          circlesRpc,
          groupService,
          logger: runLogger,
          avatarSafeMappingStore
        },
        { ...config, dryRun: effectiveDryRun }
      );
      await stateStore?.save("gp-crc", 0, { lastSuccessfulRunAt: new Date().toISOString() });
      recordRunSuccess("gp-crc", Date.now() - runStartedAt);
      errorTracker.recordSuccess();
      currentDelay = pollIntervalMs;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError("gp-crc");
      rootLogger.error(`Consecutive error ${consecutiveErrors} of ${errorsBeforeCrash}`);
      rootLogger.error(formatErrorWithCauses(error));
      if (errorTracker.shouldAlert()) {
        rootLogger.error("Consecutive error threshold reached. Exiting with code 1.");
        void notifySlackRunError(error, consecutiveErrors).catch(() => {});
        setTimeout(() => process.exit(1), 3000).unref();
        return;
      }
      currentDelay = Math.min(currentDelay * 2, maxDelay);
    }

    await delay(currentDelay);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    rootLogger.warn(`Invalid integer for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }

  return value;
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
  rootLogger.error("GP-CRC TMS Service encountered an unrecoverable error:");
  rootLogger.error(formatErrorWithCauses(error));
  void slackService.notifySlackStartOrCrash(
    `🚨 *GP-CRC TMS Service crashed*\n\nLast error: ${error.message}`, SlackSeverity.CRITICAL
  ).catch((slackError: unknown) => {
    rootLogger.warn("Failed to send crash notification to Slack:", slackError);
  });
  process.exit(1);
});

async function notifySlackStartup(): Promise<void> {
  const pollIntervalMinutes = formatMinutes(pollIntervalMs);
    const startupMessage = `✅ *GP-CRC TMS Service started*\n\n` +
    `Monitoring CRC avatars who also have a GP account in Metri.\n` +
    `- RPC: ${rpcUrl}\n` +
    `- Blacklisting Service: ${blacklistingServiceUrl}\n` +
    `- Fetch Page Size: ${fetchPageSize}\n` +
    `- Metri Safe GraphQL: ${metriSafeGraphqlUrl}\n` +
    `- Safe: ${safeAddress || "(not set)"}\n` +
    `- Safe signer configured: ${safeSignerPrivateKey.trim().length > 0}\n` +
    `- Poll Interval (minutes): ${pollIntervalMinutes}\n` +
    `- Group: ${groupAddress}\n` +
    `- Dry Run: ${dryRun}`;

  try {
    await slackService.notifySlackStartOrCrash(startupMessage, SlackSeverity.INFO);
    if (slackConfigured) {
      rootLogger.info("Slack startup notification sent successfully.");
    } else {
      rootLogger.info("Slack startup notification skipped (no webhook configured).");
    }
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack startup notification:", slackError);
  }
}


async function notifySlackRunError(error: Error, consecutiveErrors: number): Promise<void> {
  const message = `⚠️ *GP-CRC TMS Service runOnce error* (${consecutiveErrors} consecutive failures)\n\n${formatErrorWithCauses(error)}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.WARNING);
  } catch (slackError) {
    rootLogger.warn("Failed to send run error notification to Slack:", slackError);
  }
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  const rounded = Math.round(minutes * 100) / 100;
  return rounded.toString();
}
