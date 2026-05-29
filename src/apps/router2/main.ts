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
import {fetchRegisterHumanGnosisAppUserAddresses} from "../../services/gnosisAppUserService";
import {
  DEFAULT_ROUTER2_ADDRESS,
  DEFAULT_ROUTER2_BATCH_SIZE,
  DEFAULT_ROUTER2_FETCH_PAGE_SIZE,
  DEFAULT_ROUTER2_FETCH_TIMEOUT_MS,
  DEFAULT_ROUTER2_GNOSIS_APP_INDEXER_URL,
  DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS,
  InMemoryRouter2ApprovalStore,
  runOnce,
  type RunConfig
} from "./logic";

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const rootLogger = new LoggerService(verboseLogging, "router2");

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const routerAddress = process.env.ROUTER2_ADDRESS || DEFAULT_ROUTER2_ADDRESS;
const trustedByAddress = process.env.ROUTER2_TRUSTED_BY_ADDRESS || DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS;
const gnosisAppIndexerUrl = process.env.ROUTER2_GNOSIS_APP_INDEXER_URL || DEFAULT_ROUTER2_GNOSIS_APP_INDEXER_URL;
const gnosisAppFromBlock = parseOptionalEnvInt("ROUTER2_GNOSIS_APP_FROM_BLOCK");
const signerPrivateKey = process.env.ROUTER2_SIGNER_PRIVATE_KEY || "";
const dryRun = process.env.DRY_RUN === "1";
const pollIntervalMs = parseEnvInt("ROUTER2_POLL_INTERVAL_MS", 10 * 60 * 1000);
const batchSize = parseEnvInt("ROUTER2_BATCH_SIZE", DEFAULT_ROUTER2_BATCH_SIZE);
const fetchPageSize = parseEnvInt("ROUTER2_FETCH_PAGE_SIZE", DEFAULT_ROUTER2_FETCH_PAGE_SIZE);
const fetchTimeoutMs = parseEnvInt("ROUTER2_FETCH_TIMEOUT_MS", DEFAULT_ROUTER2_FETCH_TIMEOUT_MS);
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
  signerPrivateKey.trim().length > 0;
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
const runLogger = rootLogger.child("run");
const approvalStore = new InMemoryRouter2ApprovalStore();

let router2Service: Router2Service | undefined;
let executionQueue: Promise<void> = Promise.resolve();

if (!dryRun && signerPrivateKey.trim().length === 0) {
  throw new Error("ROUTER2_SIGNER_PRIVATE_KEY is required when router2 is not running in dry-run mode.");
}

if (!dryRun || canSimulateTransactions) {
  router2Service = new Router2Service(rpcUrl, routerAddress, signerPrivateKey, txRpcUrl);
}

const config: RunConfig = {
  routerAddress,
  trustedByAddress,
  gnosisAppIndexerUrl,
  gnosisAppFromBlock,
  dryRun,
  batchSize,
  fetchPageSize,
  logBatchAddresses
};

rootLogger.info("Starting router2 watcher with config:");
rootLogger.info(`  - rpcUrl=${rpcUrl}`);
rootLogger.info(`  - txRpcUrl=${txRpcUrl}`);
rootLogger.info(`  - routerAddress=${routerAddress}`);
rootLogger.info(`  - trustedByAddress=${trustedByAddress}`);
rootLogger.info(`  - gnosisAppIndexerUrl=${gnosisAppIndexerUrl}`);
rootLogger.info(`  - gnosisAppFromBlock=${gnosisAppFromBlock ?? "(not set)"}`);
rootLogger.info(`  - eoaSignerConfigured=${signerPrivateKey.trim().length > 0}`);
rootLogger.info(`  - eoaSignerAddress=${router2Service?.getSignerAddress() ?? "(not set)"}`);
rootLogger.info(`  - dryRunSimulationEnabled=${dryRunSimulationEnabled}`);
rootLogger.info(`  - dryRunSimulationConfigured=${canSimulateTransactions}`);
rootLogger.info(`  - logBatchAddresses=${logBatchAddresses}`);
rootLogger.info(`  - pollIntervalMs=${pollIntervalMs}`);
rootLogger.info(`  - batchSize=${batchSize}`);
rootLogger.info(`  - fetchPageSize=${fetchPageSize}`);
rootLogger.info(`  - fetchTimeoutMs=${fetchTimeoutMs}`);
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
            router2Service,
            approvalStore,
            fetchGnosisAppRegisterHumanAddresses: (indexerUrl, pageSize, fromBlock, logger) =>
              fetchRegisterHumanGnosisAppUserAddresses(indexerUrl, pageSize, fetchTimeoutMs, fromBlock, logger)
          },
          config
        );
      });

      if (!outcome) {
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
        `gnosisAppRegisterHumans=${outcome.uniqueGnosisAppRegisterHumanCount} ` +
        `approvals=${outcome.uniqueApprovalCount} ` +
        `cached=${outcome.cachedApprovalCount} ` +
        `approvalCandidates=${outcome.approvalCandidateCount} ` +
        `approvalTxs=${outcome.approvalTxHashes.length} ` +
        `dryRun=${outcome.dryRun}`
      );
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
    }

    await delay(currentDelay);
  }
}

async function start(): Promise<void> {
  await mainLoop();
}

async function gracefulShutdown(signal: string): Promise<void> {
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
    `Setting CRC approvals for addresses trusted by the configured truster.\n` +
    `- RPC: ${rpcUrl}\n` +
    `- TX RPC: ${txRpcUrl}\n` +
    `- Router2: ${routerAddress}\n` +
    `- Trusted By: ${trustedByAddress}\n` +
    `- Gnosis App Indexer: ${gnosisAppIndexerUrl}\n` +
    `- Gnosis App From Block: ${gnosisAppFromBlock ?? "(not set)"}\n` +
    `- EOA signer configured: ${signerPrivateKey.trim().length > 0}\n` +
    `- EOA signer: ${router2Service?.getSignerAddress() ?? "(not set)"}\n` +
    `- Poll Interval (minutes): ${formatMinutes(pollIntervalMs)}\n` +
    `- Fetch Page Size: ${fetchPageSize}\n` +
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
