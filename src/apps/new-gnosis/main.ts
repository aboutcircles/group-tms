import {Contract, Wallet} from "ethers";
import {CirclesRpc} from "@aboutcircles/sdk-rpc";
import {LoggerService} from "../../services/loggerService";
import {SlackService} from "../../services/slackService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {StateStore} from "../../services/stateStore";
import {startMetricsServer, recordRunSuccess, recordRunError} from "../../services/metricsService";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {resolveTransactionRpcUrl} from "../../services/transactionRpc";
import {createProvider, primaryRpcUrl} from "../../services/rpcProvider";
import {formatErrorWithCauses} from "../../formatError";
import {
  runOnce,
  defaultGraphQLFetcher,
  DEFAULT_CONTRACT_ADDRESS,
  DEFAULT_INDEXER_URL,
  DEFAULT_FETCH_PAGE_SIZE,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_START_BLOCK,
  DEFAULT_TRUST_BATCH_SIZE,
  RunConfig,
  RunOutcome,
  TrustBatchExecutor
} from "./logic";

const APP_NAME = "new-gnosis";
const TRUST_BATCH_ABI = [
  "function trustBatch(address[] avatar)",
  "function optOuts(address) view returns (bool)"
];
const TX_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1_000;
const READ_CONCURRENCY = 25;
const REGISTERED_HUMAN_LOOKUP_BATCH = 500;

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const rootLogger = new LoggerService(verboseLogging, APP_NAME);

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const indexerUrl = process.env.NEW_GNOSIS_INDEXER_URL || DEFAULT_INDEXER_URL;
const contractAddress = process.env.NEW_GNOSIS_CONTRACT_ADDRESS || DEFAULT_CONTRACT_ADDRESS;
const signerPrivateKey = process.env.NEW_GNOSIS_SIGNER_PRIVATE_KEY || "";
const slackWebhookUrl = process.env.NEW_GNOSIS_SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";
const dryRun = process.env.DRY_RUN === "1";
const runIntervalMinutes = Math.max(1, parseEnvInt("NEW_GNOSIS_RUN_INTERVAL_MINUTES", 30));
const runIntervalMs = runIntervalMinutes * 60 * 1_000;
const fetchPageSize = parseEnvInt("NEW_GNOSIS_FETCH_PAGE_SIZE", DEFAULT_FETCH_PAGE_SIZE);
const trustBatchSize = parseEnvInt("NEW_GNOSIS_TRUST_BATCH_SIZE", DEFAULT_TRUST_BATCH_SIZE);
const fetchTimeoutMs = Math.max(1_000, parseEnvInt("NEW_GNOSIS_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS));
const configuredStartBlock = parseEnvInt("NEW_GNOSIS_START_BLOCK", DEFAULT_START_BLOCK);
const errorsBeforeCrash = 3;

if (!dryRun && signerPrivateKey.trim().length === 0) {
  throw new Error("NEW_GNOSIS_SIGNER_PRIVATE_KEY is required when not running new-gnosis in dry-run mode");
}

const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const slackConfigured = slackWebhookUrl.trim().length > 0;
const circlesRpc = new CirclesRpc(primaryRpcUrl(rpcUrl));
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);

const readProvider = createProvider(rpcUrl);
const readContract = new Contract(contractAddress, TRUST_BATCH_ABI, readProvider);

const wallet = signerPrivateKey.trim().length > 0
  ? new Wallet(signerPrivateKey, createProvider(txRpcUrl))
  : undefined;
const signerAddress = wallet?.address ?? "(not set)";

const trustBatchExecutor: TrustBatchExecutor | undefined = wallet
  ? async (target, avatars) => {
      const contract = new Contract(target, TRUST_BATCH_ABI, wallet);
      const tx = await contract.trustBatch(avatars);
      const receipt = await waitForReceipt(tx, TX_CONFIRMATION_TIMEOUT_MS);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`trustBatch failed on-chain (tx=${tx.hash}, status=${receipt?.status})`);
      }
      return tx.hash as string;
    }
  : undefined;

const config: RunConfig = {
  indexerUrl,
  contractAddress,
  startBlock: configuredStartBlock,
  fetchPageSize,
  trustBatchSize,
  fetchTimeoutMs,
  dryRun
};

rootLogger.info("Starting new-gnosis run with config:");
rootLogger.info(`  - indexerUrl=${indexerUrl}`);
rootLogger.info(`  - contractAddress=${contractAddress}`);
rootLogger.info(`  - startBlock=${configuredStartBlock}`);
rootLogger.info(`  - fetchPageSize=${fetchPageSize}`);
rootLogger.info(`  - trustBatchSize=${trustBatchSize}`);
rootLogger.info(`  - runIntervalMinutes=${runIntervalMinutes}`);
rootLogger.info(`  - rpcUrl=${rpcUrl}`);
rootLogger.info(`  - txRpcUrl=${txRpcUrl}`);
rootLogger.info(`  - signerAddress=${signerAddress}`);
rootLogger.info(`  - dryRun=${dryRun}`);
rootLogger.info(`  - slackConfigured=${slackConfigured}`);

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

process.on("uncaughtException", async (error) => {
  rootLogger.error("Uncaught exception:", formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
  await notifySlackFatal(error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(err));
  await notifySlackFatal(err);
  process.exit(1);
});

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  try {
    await slackService.notifySlackStartOrCrash(
      `🔄 *new-gnosis* shutting down — received ${signal}.`,
      SlackSeverity.INFO
    );
  } catch (err) {
    rootLogger.warn("Failed to send Slack shutdown notification:", err);
  }
  process.exit(0);
}

async function mainLoop(): Promise<void> {
  startMetricsServer(APP_NAME);

  const stateStore = process.env.LEADER_DB_URL ? new StateStore(process.env.LEADER_DB_URL) : null;
  let nextStartBlock = configuredStartBlock;
  if (stateStore) {
    const persisted = await stateStore.load(APP_NAME);
    if (persisted) {
      nextStartBlock = persisted.lastScannedBlock;
      rootLogger.info(`[state-store] Restored startBlock=${nextStartBlock}`);
    }
  }

  const maxDelay = Math.min(runIntervalMs * 4, 15 * 60 * 1_000);
  let currentDelay = runIntervalMs;

  await notifySlackStartup();

  while (true) {
    const runStartedAt = Date.now();
    try {
      const isHealthy = await ensureRpcHealthyOrNotify({
        appName: APP_NAME,
        rpcUrl,
        logger: rootLogger
      });
      if (!isHealthy) {
        await delay(currentDelay);
        continue;
      }

      const outcome = await runOnce(
        {
          fetchUsers: (q) => defaultGraphQLFetcher(indexerUrl, q, fetchTimeoutMs),
          fetchExistingTrustees: (addr) => fetchOutgoingTrustees(circlesRpc, addr),
          filterRegisteredHumans: (addrs) => fetchRegisteredHumans(indexerUrl, addrs, fetchTimeoutMs),
          isOptedOutBatch: (addrs) => fetchIsOptedOutBatch(readContract, addrs),
          trustBatch: trustBatchExecutor,
          logger: rootLogger.child("run")
        },
        {
          ...config,
          startBlock: nextStartBlock,
          dryRun
        }
      );

      if (outcome.highestBlockSeen > nextStartBlock) {
        nextStartBlock = outcome.highestBlockSeen;
        await stateStore?.save(APP_NAME, nextStartBlock, {lastSuccessfulRunAt: new Date().toISOString()});
      }

      recordRunSuccess(APP_NAME, Date.now() - runStartedAt);
      errorTracker.recordSuccess();
      if (errorTracker.wasAlertingAndRecovered()) {
        slackService.notifySlackResolved("New Gnosis").catch((err) => {
          rootLogger.warn("Failed to send Slack resolved notification:", err);
        });
      }
      currentDelay = runIntervalMs;

      rootLogger.info(
        `Run completed. Fetched=${outcome.fetchedUsers}, ` +
        `unclaimed=${outcome.unclaimedCount}, ` +
        `optedOut=${outcome.optedOutCount}, ` +
        `alreadyTrusted=${outcome.alreadyTrustedCount}, ` +
        `newAvatars=${outcome.newAvatars.length}, ` +
        `batches=${outcome.trustBatches.length}, txs=${outcome.trustTxHashes.length}, ` +
        `highestBlock=${outcome.highestBlockSeen}.`
      );
      await notifySlackRunSummary(outcome, dryRun);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const consecutiveErrors = errorTracker.recordError();
      recordRunError(APP_NAME);
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

    const elapsed = Date.now() - runStartedAt;
    const wait = Math.max(0, currentDelay - elapsed);
    if (wait > 0) {
      rootLogger.info(`Waiting ${(wait / 60_000).toFixed(1)} minute(s) before next run.`);
      await delay(wait);
    }
  }
}

async function notifySlackStartup(): Promise<void> {
  const header = dryRun
    ? "🧪 *New Gnosis Service Started (dry-run)*"
    : "✅ *New Gnosis Service Started*";
  const message =
    `${header}\n\n` +
    `- Indexer: ${indexerUrl}\n` +
    `- Contract: ${contractAddress}\n` +
    `- RPC: ${rpcUrl}\n` +
    `- TX RPC: ${txRpcUrl}\n` +
    `- Signer (EOA): ${signerAddress}\n` +
    `- Start Block: ${configuredStartBlock}\n` +
    `- Run Interval (min): ${runIntervalMinutes}\n` +
    `- Trust Batch Size: ${trustBatchSize}\n` +
    `- Slack Configured: ${slackConfigured}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.INFO);
  } catch (err) {
    rootLogger.warn("Failed to send Slack startup notification:", err);
  }
}

async function notifySlackRunSummary(outcome: RunOutcome, effectiveDryRun: boolean): Promise<void> {
  if (outcome.newAvatars.length === 0) return;

  const header = effectiveDryRun
    ? "🧪 *New Gnosis Dry-Run Summary*"
    : "✅ *New Gnosis Run Summary*";

  const lines = [
    header,
    "",
    `- Contract: ${outcome.trustBatches.length > 0 ? contractAddress : "(no batches)"}`,
    `- Mode: ${effectiveDryRun ? "Dry Run" : "Live"}`,
    `- Fetched users: ${outcome.fetchedUsers}`,
    `- Unclaimed (skipped): ${outcome.unclaimedCount}`,
    `- Opted out (skipped): ${outcome.optedOutCount}`,
    `- Already trusted (skipped): ${outcome.alreadyTrustedCount}`,
    `- New avatars: ${outcome.newAvatars.length}`,
    `- Batches: ${outcome.trustBatches.length}`,
    `- Highest block seen: ${outcome.highestBlockSeen}`
  ];

  const sample = outcome.newAvatars.slice(0, 10);
  if (sample.length > 0) {
    const more = outcome.newAvatars.length - sample.length;
    lines.push(
      `- ${effectiveDryRun ? "Would trust" : "Trusted"}: ${sample.join(", ")}` +
      (more > 0 ? `, … (+${more} more)` : "")
    );
  }

  if (!effectiveDryRun && outcome.trustTxHashes.length > 0) {
    const sampleTxs = outcome.trustTxHashes.slice(0, 5);
    const more = outcome.trustTxHashes.length - sampleTxs.length;
    lines.push(
      `- Trust tx hash(es): ${sampleTxs.join(", ")}` +
      (more > 0 ? `, … (+${more} more)` : "")
    );
  }

  try {
    await slackService.notifySlackStartOrCrash(lines.join("\n"), SlackSeverity.INFO);
  } catch (err) {
    rootLogger.warn("Failed to send Slack run summary:", err);
  }
}

async function notifySlackRunError(error: Error, consecutiveErrors: number): Promise<void> {
  const message =
    `⚠️ *new-gnosis run failed* (${consecutiveErrors} consecutive failures)\n\n${formatErrorWithCauses(error)}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.WARNING);
  } catch (err) {
    rootLogger.warn("Failed to send Slack run error notification:", err);
  }
}

async function notifySlackFatal(error: Error): Promise<void> {
  const message = `🚨 *new-gnosis crashed*\n\n${error.message}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.CRITICAL);
  } catch (err) {
    rootLogger.warn("Failed to send Slack fatal notification:", err);
  }
}

function waitForReceipt(tx: {hash: string; wait: () => Promise<any>}, timeoutMs: number): Promise<any> {
  return Promise.race([
    tx.wait(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`tx ${tx.hash} confirmation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

async function fetchOutgoingTrustees(rpc: CirclesRpc, truster: string): Promise<string[]> {
  const relations = await rpc.trust.getAggregatedTrustRelations(truster as `0x${string}`);
  return relations
    .filter((r) => r.relation === "trusts" || r.relation === "mutuallyTrusts")
    .map((r) => r.objectAvatar);
}

async function fetchIsOptedOutBatch(contract: Contract, addresses: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  for (let i = 0; i < addresses.length; i += READ_CONCURRENCY) {
    const chunk = addresses.slice(i, i + READ_CONCURRENCY);
    const flags = await Promise.all(chunk.map((a) => contract.optOuts(a) as Promise<boolean>));
    chunk.forEach((a, idx) => result.set(a.toLowerCase(), flags[idx] === true));
  }
  return result;
}

async function fetchRegisteredHumans(
  url: string,
  addresses: string[],
  timeoutMs: number
): Promise<Set<string>> {
  const result = new Set<string>();
  for (let i = 0; i < addresses.length; i += REGISTERED_HUMAN_LOOKUP_BATCH) {
    const chunk = addresses.slice(i, i + REGISTERED_HUMAN_LOOKUP_BATCH);
    const ids = chunk.map((a) => `"${a}"`).join(",");
    const query = `{ Avatar(where:{id:{_in:[${ids}]}, avatarType:{_eq:"RegisterHuman"}}){ id } }`;
    const payload = await defaultGraphQLFetcher(url, query, timeoutMs) as {data?: {Avatar?: Array<{id: string}>}};
    for (const row of payload.data?.Avatar ?? []) {
      result.add(row.id.toLowerCase());
    }
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    rootLogger.warn(`Invalid integer for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }
  return parsed;
}

mainLoop().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("new-gnosis run encountered an unrecoverable error:");
  rootLogger.error(formatErrorWithCauses(error));
  void notifySlackFatal(error).catch((e) => rootLogger.warn("Failed to send Slack notification:", e));
  setTimeout(() => process.exit(1), 3000).unref();
});
