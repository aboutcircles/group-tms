import {CirclesRpcService} from "../../services/circlesRpcService";
import {LoggerService} from "../../services/loggerService";
import {Router2Service} from "../../services/router2Service";
import {SlackService} from "../../services/slackService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {formatErrorWithCauses} from "../../formatError";
import {recordRunError, recordRunSuccess, startMetricsServer} from "../../services/metricsService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {resolveTransactionRpcUrl} from "../../services/transactionRpc";
import {
  deriveRegisterHumanWsUrl,
  startRegisterHumanListener,
  type RegisterHumanListenerHandle
} from "../router-tms/realtime";
import {
  DEFAULT_ROUTER2_ADDRESS,
  DEFAULT_ROUTER2_ADMIN_SAFE_ADDRESS,
  DEFAULT_ROUTER2_BATCH_SIZE,
  DEFAULT_ROUTER2_FETCH_PAGE_SIZE,
  DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS,
  runApprovalsForHumanAvatars,
  runOnce,
  type RunConfig
} from "./logic";

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const rootLogger = new LoggerService(verboseLogging, "router2");

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const routerAddress = process.env.ROUTER2_ADDRESS || DEFAULT_ROUTER2_ADDRESS;
const trustedByAddress = process.env.ROUTER2_TRUSTED_BY_ADDRESS || DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS;
const safeAddress = process.env.ROUTER2_ADMIN_SAFE_ADDRESS || DEFAULT_ROUTER2_ADMIN_SAFE_ADDRESS;
const safeSignerPrivateKey = process.env.ROUTER2_SAFE_SIGNER_PRIVATE_KEY || "";
const dryRun = process.env.DRY_RUN === "1";
const pollIntervalMs = parseEnvInt("ROUTER2_POLL_INTERVAL_MS", 30 * 60 * 1000);
const batchSize = parseEnvInt("ROUTER2_BATCH_SIZE", DEFAULT_ROUTER2_BATCH_SIZE);
const fetchPageSize = parseEnvInt("ROUTER2_FETCH_PAGE_SIZE", DEFAULT_ROUTER2_FETCH_PAGE_SIZE);
const approvalsFromBlock = parseOptionalEnvInt("ROUTER2_APPROVALS_FROM_BLOCK");
const registerHumanWsUrl = process.env.ROUTER2_WSS_URL || deriveRegisterHumanWsUrl(rpcUrl);
const slackWebhookUrl = process.env.ROUTER2_SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";
const errorsBeforeCrash = Math.max(1, parseEnvInt("ROUTER2_ERRORS_BEFORE_CRASH", 5));
const dryRunSimulationEnabled = parseEnvBool("ROUTER2_DRY_RUN_SIMULATION", true);
const logBatchAddresses = parseEnvBool("ROUTER2_LOG_BATCH_ADDRESSES", false);

process.env.APP_NAME = "router2";
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const slackConfigured = slackWebhookUrl.trim().length > 0;
const circlesRpc = new CirclesRpcService(rpcUrl, (msg) => {
  console.warn(`[CirclesRpc] ${msg}`);
  void slackService.notifySlackStartOrCrash(
    `⚠️ *router2* pagination cap: ${msg}`,
    SlackSeverity.WARNING
  ).catch((e) => console.warn("[SlackAlert] failed:", (e as Error).message));
});
const canSimulateTransactions = dryRun && dryRunSimulationEnabled &&
  safeSignerPrivateKey.trim().length > 0 &&
  safeAddress.trim().length > 0;
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
const runLogger = rootLogger.child("run");

let router2Service: Router2Service | undefined;
let registerHumanListener: RegisterHumanListenerHandle | null = null;
let executionQueue: Promise<void> = Promise.resolve();

if (!dryRun && safeSignerPrivateKey.trim().length === 0) {
  throw new Error("ROUTER2_SAFE_SIGNER_PRIVATE_KEY is required when router2 is not running in dry-run mode.");
}

if (!dryRun && safeAddress.trim().length === 0) {
  throw new Error("ROUTER2_ADMIN_SAFE_ADDRESS is required when router2 is not running in dry-run mode.");
}

if (!dryRun || canSimulateTransactions) {
  router2Service = new Router2Service(rpcUrl, routerAddress, safeSignerPrivateKey, safeAddress, txRpcUrl);
}

const config: RunConfig = {
  routerAddress,
  trustedByAddress,
  dryRun,
  batchSize,
  fetchPageSize,
  approvalsFromBlock,
  logBatchAddresses
};

rootLogger.info("Starting router2 watcher with config:");
rootLogger.info(`  - rpcUrl=${rpcUrl}`);
rootLogger.info(`  - txRpcUrl=${txRpcUrl}`);
rootLogger.info(`  - registerHumanWsUrl=${registerHumanWsUrl}`);
rootLogger.info(`  - routerAddress=${routerAddress}`);
rootLogger.info(`  - trustedByAddress=${trustedByAddress}`);
rootLogger.info(`  - adminSafeAddress=${safeAddress || "(not set)"}`);
rootLogger.info(`  - safeSignerConfigured=${safeSignerPrivateKey.trim().length > 0}`);
rootLogger.info(`  - dryRunSimulationEnabled=${dryRunSimulationEnabled}`);
rootLogger.info(`  - dryRunSimulationConfigured=${canSimulateTransactions}`);
rootLogger.info(`  - logBatchAddresses=${logBatchAddresses}`);
rootLogger.info(`  - pollIntervalMs=${pollIntervalMs}`);
rootLogger.info(`  - batchSize=${batchSize}`);
rootLogger.info(`  - fetchPageSize=${fetchPageSize}`);
rootLogger.info(`  - approvalsFromBlock=${approvalsFromBlock ?? "(not set)"}`);
rootLogger.info(`  - dryRun=${dryRun}`);

void notifySlackStartup();

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

process.on("uncaughtException", async (error) => {
  rootLogger.error("Uncaught exception:", formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *router2* Uncaught exception: ${error?.message || error}`, SlackSeverity.CRITICAL);
  } catch (slackErr) {
    console.error("Failed to send Slack crash notification:", slackErr);
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(error));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *router2* Unhandled rejection: ${error.message}`, SlackSeverity.CRITICAL);
  } catch (slackErr) {
    console.error("Failed to send Slack crash notification:", slackErr);
  }
  process.exit(1);
});

async function mainLoop(): Promise<void> {
  startMetricsServer("router2");
  const maxDelay = Math.min(pollIntervalMs * 4, 15 * 60 * 1000);
  let currentDelay = pollIntervalMs;

  while (true) {
    const runStartedAt = Date.now();
    stopRealtimeRegisterHumanListener("starting scheduled router2 run");

    try {
      const outcome = await enqueueExclusive(async () => {
        const isHealthy = await ensureRpcHealthyOrNotify({
          appName: "router2",
          rpcUrl,
          logger: rootLogger
        });
        if (!isHealthy) {
          return null;
        }

        return runOnce(
          {
            circlesRpc,
            logger: runLogger,
            router2Service
          },
          config
        );
      });

      if (!outcome) {
        startRealtimeRegisterHumanListener();
        await delay(currentDelay);
        continue;
      }

      recordRunSuccess("router2", Date.now() - runStartedAt);
      errorTracker.recordSuccess();
      if (errorTracker.wasAlertingAndRecovered()) {
        slackService.notifySlackResolved("router2").catch((err) => {
          rootLogger.warn("Failed to send Slack resolved notification:", err);
        });
      }
      currentDelay = pollIntervalMs;

      runLogger.info(
        "router2 run completed: " +
        `trusted=${outcome.uniqueTrustedCount} ` +
        `routingTxs=${outcome.routingTxHashes.length} ` +
        `humans=${outcome.uniqueHumanCount} ` +
        `approvalTxs=${outcome.approvalTxHashes.length} ` +
        `dryRun=${outcome.dryRun}`
      );
      startRealtimeRegisterHumanListener();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError("router2");
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
  if (router2Service) {
    try {
      await router2Service.validateSafeOwnership();
      rootLogger.info("Safe ownership validation passed — signer is a registered owner.");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      rootLogger.error(`Safe ownership validation FAILED: ${errorMessage}`);
      try {
        await slackService.notifySlackStartOrCrash(
          `🚨 *router2 Safe ownership check failed*\n\n${errorMessage}`,
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
  realtimeLogger.info(`Processing realtime router2 approval avatar(s): ${avatars.join(", ")}`);

  try {
    const outcome = await enqueueExclusive(async () => {
      const isHealthy = await ensureRpcHealthyOrNotify({
        appName: "router2",
        rpcUrl,
        logger: rootLogger
      });
      if (!isHealthy) {
        return null;
      }

      return runApprovalsForHumanAvatars(
        {
          circlesRpc,
          logger: realtimeLogger,
          router2Service
        },
        config,
        avatars
      );
    });

    if (!outcome) {
      realtimeLogger.warn("Skipping realtime router2 approval because the RPC health check failed.");
      return;
    }

    recordRunSuccess("router2", Date.now() - startedAt);
    realtimeLogger.info(
      "router2 realtime approval completed: " +
      `humans=${outcome.uniqueHumanCount} approvalTxs=${outcome.approvalTxHashes.length}`
    );
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    recordRunError("router2");
    realtimeLogger.error("Realtime router2 approval failed:");
    realtimeLogger.error(formatErrorWithCauses(error));
  }
}

function startRealtimeRegisterHumanListener(): void {
  if (registerHumanListener) {
    return;
  }

  rootLogger.info("Starting router2 RegisterHuman realtime listener between scheduled runs.");
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

  rootLogger.info(`Stopping router2 RegisterHuman realtime listener: ${reason}.`);
  try {
    registerHumanListener.stop();
  } catch (error) {
    rootLogger.warn("Failed to stop RegisterHuman listener:", error);
  } finally {
    registerHumanListener = null;
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  stopRealtimeRegisterHumanListener(`graceful shutdown (${signal})`);
  try {
    await slackService.notifySlackStartOrCrash(
      `🔄 *router2 service shutting down*\n\nService received ${signal} signal.`,
      SlackSeverity.INFO
    );
  } catch (error) {
    rootLogger.error("Failed to send shutdown notification:", error);
  }
  process.exit(0);
}

start().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("router2 service crashed:");
  rootLogger.error(formatErrorWithCauses(error));
  void slackService.notifySlackStartOrCrash(
    `🚨 *router2 service crashed*\n\nLast error: ${error.message}`,
    SlackSeverity.CRITICAL
  ).catch((slackError: unknown) => {
    rootLogger.warn("Failed to send crash notification to Slack:", slackError);
  });
  process.exit(1);
});

async function notifySlackStartup(): Promise<void> {
  const message = `✅ *router2 service started*\n\n` +
    `Enabling router2 routing for addresses trusted by the configured truster and setting CRC approvals for Circles v2 humans.\n` +
    `- RegisterHuman WSS: ${registerHumanWsUrl}\n` +
    `- RPC: ${rpcUrl}\n` +
    `- TX RPC: ${txRpcUrl}\n` +
    `- Router2: ${routerAddress}\n` +
    `- Trusted By: ${trustedByAddress}\n` +
    `- Admin Safe: ${safeAddress || "(not set)"}\n` +
    `- Safe signer configured: ${safeSignerPrivateKey.trim().length > 0}\n` +
    `- Poll Interval (minutes): ${formatMinutes(pollIntervalMs)}\n` +
    `- Approvals From Block: ${approvalsFromBlock ?? "(not set)"}\n` +
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
  const message = `⚠️ *router2 run failed* (${consecutiveErrors} consecutive failures)\n\n${formatErrorWithCauses(error)}`;
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
  if (Number.isNaN(value)) {
    rootLogger.warn(`Invalid integer for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }

  return value;
}

function parseOptionalEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid non-negative integer for ${name}='${raw}'.`);
  }

  return value;
}

function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  rootLogger.warn(`Invalid boolean for ${name}='${raw}', using fallback ${fallback}.`);
  return fallback;
}

function enqueueExclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = executionQueue.then(task, task);
  executionQueue = next.then(() => undefined, () => undefined);
  return next;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  const rounded = Math.round(minutes * 100) / 100;
  return rounded.toString();
}
