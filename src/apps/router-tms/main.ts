import {CirclesRpcService} from "../../services/circlesRpcService";
import {LoggerService} from "../../services/loggerService";
import {SlackService} from "../../services/slackService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {RouterService} from "../../services/routerService";
import {BlacklistingService} from "../../services/blacklistingService";
import {
  runOnce,
  runForHumanAvatars,
  RunConfig,
  DEFAULT_ENABLE_BATCH_SIZE,
  DEFAULT_FETCH_PAGE_SIZE,
  DEFAULT_BASE_GROUP_ADDRESS
} from "./logic";
import {
  deriveRegisterHumanWsUrl,
  startRegisterHumanListener,
  type RegisterHumanListenerHandle
} from "./realtime";
import {formatErrorWithCauses} from "../../formatError";
import {startMetricsServer, recordRunSuccess, recordRunError} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {InMemoryRouterEnablementStore} from "./enablementStore";
import {PgRouterEnablementStore} from "./pgRouterEnablementStore";
import {IRouterEnablementStore} from "../../interfaces/IRouterEnablementStore";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {StateStore} from "../../services/stateStore";
import {resolveTransactionRpcUrl} from "../../services/transactionRpc";

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const routerAddress = process.env.ROUTER_ADDRESS || "0xdc287474114cc0551a81ddc2eb51783fbf34802f";
const baseGroupAddress = process.env.ROUTER_BASE_GROUP_ADDRESS || DEFAULT_BASE_GROUP_ADDRESS;
const dryRun = process.env.DRY_RUN === "1";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const pollIntervalMs = parseEnvInt("ROUTER_POLL_INTERVAL_MS", 30 * 60 * 1000);
const enableBatchSize = parseEnvInt("ROUTER_ENABLE_BATCH_SIZE", DEFAULT_ENABLE_BATCH_SIZE);
const fetchPageSize = parseEnvInt("ROUTER_FETCH_PAGE_SIZE", DEFAULT_FETCH_PAGE_SIZE);
const registerHumanWsUrl = process.env.ROUTER_WSS_URL || deriveRegisterHumanWsUrl(rpcUrl);
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";
const safeAddress = process.env.ROUTER_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.ROUTER_SAFE_SIGNER_PRIVATE_KEY || "";
const canSimulateTransactions = safeSignerPrivateKey.trim().length > 0 && safeAddress.trim().length > 0;
const blacklistingServiceUrl = process.env.BLACKLISTING_SERVICE_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist";

const rootLogger = new LoggerService(verboseLogging, "router-tms");
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const slackConfigured = slackWebhookUrl.trim().length > 0;
const circlesRpc = new CirclesRpcService(rpcUrl, (msg) => {
  console.warn(`[CirclesRpc] ${msg}`);
  void slackService.notifySlackStartOrCrash(`⚠️ *router-tms* pagination cap: ${msg}`, SlackSeverity.WARNING).catch((e) => console.warn("[SlackAlert] failed:", (e as Error).message));
});
const blacklistTimeoutMs = (() => {
  const raw = process.env.BLACKLIST_TIMEOUT_MS;
  if (!raw) return 60_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) { console.warn(`[config] Invalid BLACKLIST_TIMEOUT_MS="${raw}", using default 60000`); return 60_000; }
  return parsed;
})();
const blacklistingService = new BlacklistingService(blacklistingServiceUrl, blacklistTimeoutMs);
const quarantineTtlHours = parseEnvInt("ROUTER_QUARANTINE_TTL_HOURS", 24);
const quarantineTtlMs = quarantineTtlHours * 60 * 60 * 1000;
// Persist enablement + quarantine state when LEADER_DB_URL is available.
// Without persistence, every restart re-emits ~7k enableCRCForRouting txs
// because the in-memory dedup cache can't tell "previously enabled but
// reverted/revoked on-chain" from "never tried" — both fall through to
// `!routerTrustSet.has(avatar)` which is true for both.
const enablementStore: IRouterEnablementStore = process.env.LEADER_DB_URL
  ? new PgRouterEnablementStore(process.env.LEADER_DB_URL, quarantineTtlMs)
  : new InMemoryRouterEnablementStore([], quarantineTtlMs);
const errorsBeforeCrash = Math.max(1, parseEnvInt("ERRORS_BEFORE_CRASH", 5));
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
let registerHumanListener: RegisterHumanListenerHandle | null = null;
let executionQueue: Promise<void> = Promise.resolve();

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

function startRealtimeRegisterHumanListener(): void {
  if (registerHumanListener) {
    return;
  }

  rootLogger.info("Starting RegisterHuman realtime listener between scheduled runs.");
  registerHumanListener = startRegisterHumanListener({
    httpRpcUrl: rpcUrl,
    wsUrl: registerHumanWsUrl,
    logger: rootLogger.child("register-human"),
    onHumansRegistered: handleRealtimeHumanRegistrations
  });
}

function stopRealtimeRegisterHumanListener(reason: string): void {
  if (!registerHumanListener) {
    return;
  }

  rootLogger.info(`Stopping RegisterHuman realtime listener: ${reason}.`);
  try {
    registerHumanListener.stop();
  } catch (error) {
    rootLogger.warn("Failed to stop RegisterHuman listener:", error);
  } finally {
    registerHumanListener = null;
  }
}

let routerService: RouterService | undefined;
if (!dryRun || canSimulateTransactions) {
  if (!safeSignerPrivateKey || safeSignerPrivateKey.trim().length === 0) {
    throw new Error("ROUTER_SAFE_SIGNER_PRIVATE_KEY is required when router-tms is not in dry-run mode.");
  }
  if (!safeAddress || safeAddress.trim().length === 0) {
    throw new Error("ROUTER_SAFE_ADDRESS is required when router-tms is not in dry-run mode.");
  }
  routerService = new RouterService(rpcUrl, routerAddress, safeSignerPrivateKey, safeAddress, txRpcUrl);
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
  stopRealtimeRegisterHumanListener(`graceful shutdown (${signal})`);
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
  } catch (slackErr) {
    console.error("Failed to send Slack crash notification:", slackErr);
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(error));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *router-tms* Unhandled rejection: ${error.message}`, SlackSeverity.CRITICAL);
  } catch (slackErr) {
    console.error("Failed to send Slack crash notification:", slackErr);
  }
  process.exit(1);
});

async function mainLoop(): Promise<void> {
  startMetricsServer("router-tms");
  const maxDelay = Math.min(pollIntervalMs * 4, 15 * 60 * 1000); // cap at 15 min
  let currentDelay = pollIntervalMs;
  const stateStore = process.env.LEADER_DB_URL ? new StateStore(process.env.LEADER_DB_URL) : null;

  while (true) {
    const runStartedAt = Date.now();
    stopRealtimeRegisterHumanListener("starting scheduled router-tms run");
    try {
      const outcome = await enqueueExclusive(async () => {
        const isHealthy = await ensureRpcHealthyOrNotify({
          appName: "router-tms",
          rpcUrl,
          logger: rootLogger
        });
        if (!isHealthy) {
          return null;
        }

        await refreshBlacklist();
        return runOnce(
          {
            circlesRpc,
            blacklistingService,
            routerService,
            logger: runLogger,
            enablementStore
          },
          config
        );
      });
      if (!outcome) {
        startRealtimeRegisterHumanListener();
        await delay(currentDelay);
        continue;
      }
      const allPendingFailed = outcome.pendingEnableCount > 0 && outcome.executedEnableCount === 0 && outcome.failedBatches.length > 0;
      if (allPendingFailed) {
        // All batches failed — treat as a run error for crash threshold
        const consecutiveErrors = errorTracker.recordError();
        recordRunError("router-tms");
        rootLogger.error(`All ${outcome.failedBatches.length} batch(es) failed — counting as error ${consecutiveErrors} of ${errorsBeforeCrash}`);
        if (errorTracker.shouldAlert()) {
          rootLogger.error("Consecutive error threshold reached. Exiting with code 1.");
          void notifySlackRunError(new Error(`All batches failed: ${outcome.failedBatches.map(fb => fb.error).join("; ")}`), consecutiveErrors).catch((e) => rootLogger.warn("Failed to send Slack notification:", e));
          setTimeout(() => process.exit(1), 3000).unref();
          return;
        }
        currentDelay = Math.min(currentDelay * 2, maxDelay);
      } else {
        await stateStore?.save("router-tms", 0, { lastSuccessfulRunAt: new Date().toISOString() });
        recordRunSuccess("router-tms", Date.now() - runStartedAt);
        errorTracker.recordSuccess();
        if (errorTracker.wasAlertingAndRecovered()) {
          slackService.notifySlackResolved("Router TMS").catch((err) => {
            rootLogger.warn("Failed to send Slack resolved notification:", err);
          });
        }
        currentDelay = pollIntervalMs;
      }
      runLogger.info(
        "router-tms run completed: " +
          `uniqueHumans=${outcome.uniqueHumanCount} ` +
          `allowed=${outcome.allowedHumanCount} ` +
          `blacklisted=${outcome.blacklistedHumanCount} ` +
          `pending=${outcome.pendingEnableCount} ` +
          `executed=${outcome.executedEnableCount} ` +
          `failedBatches=${outcome.failedBatches.length} ` +
          `quarantined=${outcome.quarantinedAddresses.length}`
      );
      if (outcome.quarantinedAddresses.length > 0) {
        runLogger.warn(
          `Quarantined ${outcome.quarantinedAddresses.length} address(es) that cause on-chain reverts: ` +
          outcome.quarantinedAddresses.join(", ")
        );
        void notifySlackQuarantine(outcome.quarantinedAddresses).catch((e) => rootLogger.warn("Failed to send Slack notification:", e));
      }
      if (outcome.failedBatches.length > 0) {
        for (const fb of outcome.failedBatches) {
          runLogger.warn(
            `Failed batch ${fb.batchIndex} (${fb.batchSize} addresses, ${fb.failureType}) for base group ${fb.baseGroup}: ${fb.error}`
          );
        }
      }
      if (outcome.pendingEnableCount === 0 && outcome.failedBatches.length === 0) {
        runLogger.info("Router already trusts every allowed human avatar.");
      }
      startRealtimeRegisterHumanListener();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError("router-tms");
      rootLogger.error(`Consecutive error ${consecutiveErrors} of ${errorsBeforeCrash}`);
      rootLogger.error(formatErrorWithCauses(error));
      if (errorTracker.shouldAlert()) {
        rootLogger.error("Consecutive error threshold reached. Exiting with code 1.");
        void notifySlackRunError(error, consecutiveErrors).catch((e) => rootLogger.warn("Failed to send Slack notification:", e));
        setTimeout(() => process.exit(1), 3000).unref();
        return;
      }
      currentDelay = Math.min(currentDelay * 2, maxDelay);
      startRealtimeRegisterHumanListener();
    }

    await delay(currentDelay);
  }
}

async function start(): Promise<void> {
  if (routerService) {
    try {
      await routerService.validateSafeOwnership();
      rootLogger.info("Safe ownership validation passed — signer is a registered owner.");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      rootLogger.error(`Safe ownership validation FAILED: ${errorMessage}`);
      try {
        await slackService.notifySlackStartOrCrash(
          `🚨 *Router-TMS Safe ownership check failed*\n\n${errorMessage}`,
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

async function handleRealtimeHumanRegistrations(avatars: string[]): Promise<void> {
  if (avatars.length === 0) {
    return;
  }

  const startedAt = Date.now();
  const realtimeLogger = runLogger.child("realtime");
  realtimeLogger.info(
    `Processing realtime RegisterHuman avatar(s): ${avatars.join(", ")}`
  );

  try {
    const outcome = await enqueueExclusive(async () => {
      const isHealthy = await ensureRpcHealthyOrNotify({
        appName: "router-tms",
        rpcUrl,
        logger: rootLogger
      });
      if (!isHealthy) {
        return null;
      }

      await refreshBlacklist();
      return runForHumanAvatars(
        {
          circlesRpc,
          blacklistingService,
          routerService,
          logger: realtimeLogger,
          enablementStore
        },
        config,
        avatars
      );
    });

    if (!outcome) {
      realtimeLogger.warn("Skipping realtime routing enablement because the RPC health check failed.");
      return;
    }

    recordRunSuccess("router-tms", Date.now() - startedAt);
    realtimeLogger.info(
      "router-tms realtime batch completed: " +
        `uniqueHumans=${outcome.uniqueHumanCount} ` +
        `allowed=${outcome.allowedHumanCount} ` +
        `blacklisted=${outcome.blacklistedHumanCount} ` +
        `pending=${outcome.pendingEnableCount} ` +
        `executed=${outcome.executedEnableCount}`
    );
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    recordRunError("router-tms");
    realtimeLogger.error("Realtime routing enablement failed:");
    realtimeLogger.error(formatErrorWithCauses(error));
  }
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
    `Enabling routing only for non-blacklisted v2 human avatars.\n` +
    `- RegisterHuman WSS: ${registerHumanWsUrl}\n` +
    `- RPC: ${rpcUrl}\n` +
    `- TX RPC: ${txRpcUrl}\n` +
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

async function notifySlackQuarantine(addresses: string[]): Promise<void> {
  const message = `🔒 *Router-TMS quarantined ${addresses.length} address(es)*\n\n` +
    `These addresses cause on-chain reverts in \`enableCRCForRouting\` and were excluded from batch execution.\n` +
    `Addresses:\n${addresses.map(a => `• \`${a}\``).join("\n")}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.WARNING);
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack quarantine notification:", slackError);
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

function enqueueExclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = executionQueue.then(task, task);
  executionQueue = next.then(() => undefined, () => undefined);
  return next;
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    rootLogger.warn(`Invalid integer for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }
  return value;
}
