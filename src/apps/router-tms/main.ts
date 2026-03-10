import {CirclesRpcService} from "../../services/circlesRpcService";
import {LoggerService} from "../../services/loggerService";
import {SlackService} from "../../services/slackService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {RouterService} from "../../services/routerService";
import {BlacklistingService} from "../../services/blacklistingService";
import {
  runOnce,
  RunConfig,
  DEFAULT_ENABLE_BATCH_SIZE,
  DEFAULT_FETCH_PAGE_SIZE,
  DEFAULT_BASE_GROUP_ADDRESS
} from "./logic";
import {formatErrorWithCauses} from "../../formatError";
import {startMetricsServer, recordRunSuccess, recordRunError, setLeaderStatus} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {InMemoryRouterEnablementStore} from "./enablementStore";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {LeaderElection, getEffectiveDryRun} from "../../services/leaderElection";
import {StateStore} from "../../services/stateStore";

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const routerAddress = process.env.ROUTER_ADDRESS || "0xdc287474114cc0551a81ddc2eb51783fbf34802f";
const baseGroupAddress = process.env.ROUTER_BASE_GROUP_ADDRESS || DEFAULT_BASE_GROUP_ADDRESS;
const dryRun = process.env.DRY_RUN === "1";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const pollIntervalMs = parseEnvInt("ROUTER_POLL_INTERVAL_MS", 30 * 60 * 1000);
const enableBatchSize = parseEnvInt("ROUTER_ENABLE_BATCH_SIZE", DEFAULT_ENABLE_BATCH_SIZE);
const fetchPageSize = parseEnvInt("ROUTER_FETCH_PAGE_SIZE", DEFAULT_FETCH_PAGE_SIZE);
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const safeAddress = process.env.ROUTER_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.ROUTER_SAFE_SIGNER_PRIVATE_KEY || "";
const blacklistingServiceUrl = process.env.BLACKLISTING_SERVICE_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist";

const rootLogger = new LoggerService(verboseLogging, "router-tms");
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo);
const slackConfigured = slackWebhookUrl.trim().length > 0;
const circlesRpc = new CirclesRpcService(rpcUrl);
const blacklistingService = new BlacklistingService(blacklistingServiceUrl);
const enablementStore = new InMemoryRouterEnablementStore();
const errorsBeforeCrash = 3;
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
let leaderElection: LeaderElection | null = null;

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

let routerService: RouterService | undefined;
if (!dryRun) {
  if (!safeSignerPrivateKey || safeSignerPrivateKey.trim().length === 0) {
    throw new Error("ROUTER_SAFE_SIGNER_PRIVATE_KEY is required when router-tms is not in dry-run mode.");
  }
  if (!safeAddress || safeAddress.trim().length === 0) {
    throw new Error("ROUTER_SAFE_ADDRESS is required when router-tms is not in dry-run mode.");
  }
  routerService = new RouterService(rpcUrl, routerAddress, safeSignerPrivateKey, safeAddress);
}

const config: RunConfig = {
  rpcUrl,
  routerAddress,
  baseGroupAddress,
  dryRun,
  enableBatchSize,
  fetchPageSize
};

const runLogger = rootLogger.child("run");

void notifySlackStartup();

async function gracefulShutdown(signal: string) {
  try {
    await leaderElection?.stop();
  } catch (err) {
    rootLogger.warn("Failed to stop leader election:", err);
  }
  try {
    await slackService.notifySlackStartOrCrash(
      `🔄 *Router-TMS Service shutting down*\n\nService received ${signal} signal.`, SlackSeverity.INFO
    );
  } catch (error) {
    rootLogger.error("Failed to send shutdown notification:", error);
  }
  process.exit(0);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

process.on("uncaughtException", async (error) => {
  rootLogger.error("Uncaught exception:", formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *router-tms* Uncaught exception: ${error?.message || error}`, SlackSeverity.CRITICAL);
  } catch {}
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(error));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *router-tms* Unhandled rejection: ${error.message}`, SlackSeverity.CRITICAL);
  } catch {}
  process.exit(1);
});

async function mainLoop(): Promise<void> {
  startMetricsServer("router-tms");
  leaderElection = await LeaderElection.create(
    process.env.LEADER_DB_URL,
    process.env.INSTANCE_ID,
    slackService,
    (isLeader) => setLeaderStatus("router-tms", isLeader)
  );
  const maxDelay = pollIntervalMs * 4;
  let currentDelay = pollIntervalMs;
  const stateStore = process.env.LEADER_DB_URL ? new StateStore(process.env.LEADER_DB_URL) : null;

  while (true) {
    const runStartedAt = Date.now();
    const effectiveDryRun = getEffectiveDryRun(leaderElection, dryRun);
    try {
      const isHealthy = await ensureRpcHealthyOrNotify({
        appName: "router-tms",
        rpcUrl,
        logger: rootLogger
      });
      if (!isHealthy) { await delay(currentDelay); continue; }
      await refreshBlacklist();
      const outcome = await runOnce(
        {
          circlesRpc,
          blacklistingService,
          routerService,
          logger: runLogger,
          enablementStore
        },
        { ...config, dryRun: effectiveDryRun }
      );
      await stateStore?.save("router-tms", 0, { lastSuccessfulRunAt: new Date().toISOString() });
      recordRunSuccess("router-tms", Date.now() - runStartedAt);
      errorTracker.recordSuccess();
      currentDelay = pollIntervalMs;
      runLogger.info(
        "router-tms run completed: " +
          `uniqueHumans=${outcome.uniqueHumanCount} ` +
          `allowed=${outcome.allowedHumanCount} ` +
          `blacklisted=${outcome.blacklistedHumanCount} ` +
          `pending=${outcome.pendingEnableCount} ` +
          `executed=${outcome.executedEnableCount}`
      );
      if (outcome.pendingEnableCount === 0) {
        runLogger.info("Router already trusts every allowed human avatar.");
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError("router-tms");
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

async function start(): Promise<void> {
  await mainLoop();
}

start().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("Router-TMS service crashed:");
  rootLogger.error(formatErrorWithCauses(error));
  void slackService.notifySlackStartOrCrash(
    `🚨 *Router-TMS Service crashed*\n\nLast error: ${error.message}`, SlackSeverity.CRITICAL
  ).catch((slackError: unknown) => {
    rootLogger.warn("Failed to send crash notification to Slack:", slackError);
  });
  process.exit(1);
});

async function notifySlackStartup(): Promise<void> {
  const pollIntervalMinutes = formatMinutes(pollIntervalMs);
  const message = `✅ *Router-TMS Service started*\n\n` +
    `Enabling routing for every non-blacklisted human avatar.\n` +
    `- RPC: ${rpcUrl}\n` +
    `- Router: ${routerAddress}\n` +
    `- Base Group: ${baseGroupAddress}\n` +
    `- Blacklisting Service: ${blacklistingServiceUrl}\n` +
    `- Safe: ${safeAddress || "(not set)"}\n` +
    `- Safe signer configured: ${safeSignerPrivateKey.trim().length > 0}\n` +
    `- Poll Interval (minutes): ${pollIntervalMinutes}\n` +
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
  const message = `⚠️ *Router-TMS run failed* (${consecutiveErrors} consecutive failures)\n\n${formatErrorWithCauses(error)}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.WARNING);
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack run-error notification:", slackError);
  }
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  const rounded = Math.round(minutes * 100) / 100;
  return rounded.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    return fallback;
  }
  return value;
}
