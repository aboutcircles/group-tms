import {Wallet} from "ethers";

import {IGroupService} from "../../interfaces/IGroupService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {formatErrorWithCauses} from "../../formatError";
import {getEffectiveDryRun, LeaderElection} from "../../services/leaderElection";
import {LoggerService} from "../../services/loggerService";
import {recordRunError, recordRunSuccess, setLeaderStatus, startMetricsServer} from "../../services/metricsService";
import {resolveTransactionRpcUrl} from "../../services/transactionRpc";
import {SafeGroupService} from "../../services/safeGroupService";
import {SlackService} from "../../services/slackService";
import {StateStore} from "../../services/stateStore";
import {CirclesRpcService} from "../../services/circlesRpcService";
import {
  DEFAULT_GROUP_AFFILIATES_BATCH_SIZE,
  DEFAULT_MANAGED_GROUP_ADDRESSES,
  DEFAULT_REPUTATION_SCORE_THRESHOLD,
  runReputationReconciliation,
  runForAffiliateEvents,
  type RunConfig
} from "./logic";
import {BulkReputationService, IReputationService, ReputationService} from "./reputationService";
import {
  AffiliateGroupChangedListenerHandle,
  AffiliateGroupChangedWithCursor,
  EventCursor,
  deriveGroupAffiliatesWsUrl,
  fetchAffiliateGroupChangedEventsBetween,
  fetchCurrentBlockNumber,
  makeHeadCursor,
  makeInclusiveBlockCursor,
  maxCursor,
  startAffiliateGroupChangedListener
} from "./realtime";

const APP_NAME = "group-affiliates";
const DEFAULT_AFFILIATE_REGISTRY_ADDRESS = "0xca8222e780d046707083f51377b5fd85e2866014";
const DEFAULT_REPUTATION_BASE_URL = "https://walrus-app-2-iod58.ondigitalocean.app/aboutcircles-advanced-analytics2/rep_score/groups/gnosis/avatars";
const DEFAULT_START_BLOCK = 41_734_312;

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const affiliateRegistryAddress = (process.env.GROUP_AFFILIATES_REGISTRY_ADDRESS || DEFAULT_AFFILIATE_REGISTRY_ADDRESS).toLowerCase();
const wsUrl = process.env.GROUP_AFFILIATES_WSS_URL || deriveGroupAffiliatesWsUrl(rpcUrl);
const startBlock = parseEnvInt("GROUP_AFFILIATES_START_BLOCK", DEFAULT_START_BLOCK);
const confirmationBlocks = parseEnvInt("CONFIRMATION_BLOCKS", 2);
const batchSize = parseEnvInt("GROUP_AFFILIATES_BATCH_SIZE", DEFAULT_GROUP_AFFILIATES_BATCH_SIZE);
const reputationScoreThreshold = parseEnvNumber("GROUP_AFFILIATES_REPUTATION_SCORE_THRESHOLD", DEFAULT_REPUTATION_SCORE_THRESHOLD);
const reputationBaseUrl = process.env.GROUP_AFFILIATES_REPUTATION_BASE_URL || DEFAULT_REPUTATION_BASE_URL;
const reputationTimeoutMs = parseEnvInt("GROUP_AFFILIATES_REPUTATION_TIMEOUT_MS", 30_000);
const reputationRefreshMs = parseEnvInt("GROUP_AFFILIATES_REPUTATION_REFRESH_MS", 30 * 60 * 1000);
const reputationConcurrency = parseEnvInt("GROUP_AFFILIATES_REPUTATION_CONCURRENCY", 8);
const dryRun = process.env.DRY_RUN === "1";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const safeAddress = process.env.GROUP_AFFILIATES_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.GROUP_AFFILIATES_SAFE_SIGNER_PRIVATE_KEY || "";
const configuredSignerAddress = (process.env.GROUP_AFFILIATES_SIGNER_ADDRESS || "").toLowerCase();
const canSimulateTransactions = safeAddress.trim().length > 0 && safeSignerPrivateKey.trim().length > 0;
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";

const rootLogger = new LoggerService(verboseLogging, APP_NAME);
const runLogger = rootLogger.child("run");
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const slackConfigured = slackWebhookUrl.trim().length > 0;
const errorsBeforeCrash = Math.max(1, parseEnvInt("ERRORS_BEFORE_CRASH", 5));
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
const circlesRpc = new CirclesRpcService(rpcUrl, (message) => {
  console.warn(`[CirclesRpc] ${message}`);
  void slackService.notifySlackStartOrCrash(
    `⚠️ *group-affiliates* pagination cap: ${message}`,
    SlackSeverity.WARNING
  ).catch((error) => console.warn("[SlackAlert] failed:", (error as Error).message));
});
// Bulk reputation (default): page the rep_score /scores endpoint once
// into a short-lived snapshot instead of one HTTP request per address.
// The per-address path fans out one request per trustee on the full
// reconcile (thousands), blowing the rep_score rate limit → AbortError
// → crash loop. Disable with GROUP_AFFILIATES_REPUTATION_BULK=0.
const reputationBulkEnabled = process.env.GROUP_AFFILIATES_REPUTATION_BULK !== "0";
const reputationScoresUrl =
  process.env.GROUP_AFFILIATES_REPUTATION_SCORES_URL ||
  (/\/avatars\/*$/.test(reputationBaseUrl) ? reputationBaseUrl.replace(/\/avatars\/*$/, "/scores") : "");
const reputationSnapshotTtlMs = Math.max(
  60_000,
  parseEnvInt("GROUP_AFFILIATES_REPUTATION_SNAPSHOT_TTL_MS", reputationRefreshMs > 0 ? reputationRefreshMs : 5 * 60 * 1000)
);
const useBulkReputation = reputationBulkEnabled && reputationScoresUrl.length > 0;
const reputationService: IReputationService = useBulkReputation
  ? new BulkReputationService(reputationScoresUrl, reputationTimeoutMs, reputationSnapshotTtlMs)
  : new ReputationService(reputationBaseUrl, reputationTimeoutMs, reputationConcurrency);
const reputationModeLabel = useBulkReputation
  ? `bulk (${reputationScoresUrl}, ttl ${reputationSnapshotTtlMs}ms)`
  : `per-address (${reputationBaseUrl}, concurrency ${reputationConcurrency})`;

let leaderElection: LeaderElection | null = null;
let listener: AffiliateGroupChangedListenerHandle | null = null;
let groupService: IGroupService;
let executionQueue: Promise<void> = Promise.resolve();
let reputationRefreshTimer: NodeJS.Timeout | null = null;

const config: RunConfig = {
  managedGroupAddresses: DEFAULT_MANAGED_GROUP_ADDRESSES,
  batchSize,
  reputationScoreThreshold,
  dryRun
};

validateConfig();

if (!dryRun || canSimulateTransactions) {
  groupService = new SafeGroupService(rpcUrl, safeSignerPrivateKey, safeAddress, txRpcUrl);
} else {
  groupService = createDryRunGroupService();
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

process.on("uncaughtException", async (error) => {
  rootLogger.error("Uncaught exception:", formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *group-affiliates* Uncaught exception: ${error?.message || error}`, SlackSeverity.CRITICAL);
  } catch (slackError) {
    console.error("Failed to send Slack crash notification:", slackError);
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  rootLogger.error("Unhandled rejection:", formatErrorWithCauses(error));
  try {
    await slackService.notifySlackStartOrCrash(`💥 *group-affiliates* Unhandled rejection: ${error.message}`, SlackSeverity.CRITICAL);
  } catch (slackError) {
    console.error("Failed to send Slack crash notification:", slackError);
  }
  process.exit(1);
});

async function start(): Promise<void> {
  startMetricsServer(APP_NAME);
  leaderElection = await LeaderElection.create(
    process.env.LEADER_DB_URL,
    process.env.INSTANCE_ID,
    rootLogger.child("leader-election"),
    slackService,
    (isLeader) => setLeaderStatus(APP_NAME, isLeader)
  );

  if (groupService.validateSafeOwnership) {
    try {
      await groupService.validateSafeOwnership();
      rootLogger.info("Safe ownership validation passed — signer is a registered owner.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rootLogger.error(`Safe ownership validation FAILED: ${message}`);
      await slackService.notifySlackStartOrCrash(
        `🚨 *Group Affiliates Safe ownership check failed*\n\n${message}`,
        SlackSeverity.CRITICAL
      ).catch((slackError) => rootLogger.warn("Failed to send Slack ownership failure notification:", slackError));
      process.exit(1);
    }
  }

  await notifySlackStartup();

  const stateStore = process.env.LEADER_DB_URL ? new StateStore(process.env.LEADER_DB_URL) : null;
  let cursor = await loadCursor(stateStore);

  try {
    cursor = await runStartupReplay(stateStore, cursor);
    startRealtimeListener(stateStore, cursor);
    startReputationReconciliationLoop();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    recordRunError(APP_NAME);
    rootLogger.error("Startup replay failed:");
    rootLogger.error(formatErrorWithCauses(error));
    await notifySlackRunError(error, 1);
    process.exit(1);
  }

  await new Promise(() => undefined);
}

async function runStartupReplay(
  stateStore: StateStore | null,
  cursor: EventCursor
): Promise<EventCursor> {
  const effectiveDryRun = getEffectiveDryRun(leaderElection, dryRun);
  const isHealthy = await ensureRpcHealthyOrNotify({
    appName: APP_NAME,
    rpcUrl,
    logger: rootLogger
  });
  if (!isHealthy) {
    return cursor;
  }

  const head = await fetchCurrentBlockNumber(rpcUrl);
  if (head === null) {
    throw new Error("Failed to fetch current block number for startup replay.");
  }

  const safeHead = Math.max(0, head - confirmationBlocks);
  if (safeHead < cursor.blockNumber) {
    runLogger.info(`Startup replay skipped: cursor=${formatCursor(cursor)} safeHead=${safeHead}`);
    return cursor;
  }

  runLogger.info(`Startup replay range: cursor=${formatCursor(cursor)} safeHead=${safeHead}`);
  const events = await fetchAffiliateGroupChangedEventsBetween(
    rpcUrl,
    affiliateRegistryAddress,
    cursor.blockNumber,
    safeHead,
    cursor,
    runLogger
  );

  const shouldAdvance = await processEvents(events, effectiveDryRun);
  const replayCursor = makeHeadCursor(safeHead);
  if (shouldAdvance) {
    await saveCursor(stateStore, replayCursor);
    return replayCursor;
  }
  return cursor;
}

function startRealtimeListener(stateStore: StateStore | null, cursor: EventCursor): void {
  if (listener) {
    return;
  }

  rootLogger.info(`Starting AffiliateGroupChanged WSS listener from cursor=${formatCursor(cursor)}.`);
  listener = startAffiliateGroupChangedListener({
    httpRpcUrl: rpcUrl,
    wsUrl,
    registryAddress: affiliateRegistryAddress,
    logger: rootLogger.child("wss"),
    startCursor: cursor,
    onEvents: async (events) => {
      return enqueueExclusive(async () => {
        const effectiveDryRun = getEffectiveDryRun(leaderElection, dryRun);
        const shouldAdvance = await processEvents(events, effectiveDryRun);
        if (shouldAdvance && events.length > 0) {
          const latest = events[events.length - 1].cursor;
          await saveCursor(stateStore, latest);
        }
        return shouldAdvance;
      });
    }
  });
}

// Returns true when the batch was processed successfully, meaning the
// scan cursor may advance and persist. This is deliberately decoupled
// from dry-run: dry-run only suppresses sending trust txs (handled by
// config.dryRun inside runForAffiliateEvents) — the worker has still
// observed these events. Tying advancement to !dryRun kept lastSeenCursor
// and the persisted cursor pinned at the start block, so every flush
// re-processed the same events and every restart full-replayed millions
// of blocks (the node-wedging load this worker is meant to avoid).
async function processEvents(
  events: AffiliateGroupChangedWithCursor[],
  effectiveDryRun: boolean
): Promise<boolean> {
  if (events.length === 0) {
    runLogger.info("No group affiliate events to process.");
    recordRunSuccess(APP_NAME, 0);
    return true;
  }

  const startedAt = Date.now();
  try {
    const outcome = await runForAffiliateEvents(
      {circlesRpc, groupService, reputationService, logger: runLogger},
      {...config, dryRun: effectiveDryRun},
      events
    );
    recordRunSuccess(APP_NAME, Date.now() - startedAt);
    errorTracker.recordSuccess();
    if (errorTracker.wasAlertingAndRecovered()) {
      slackService.notifySlackResolved("Group Affiliates").catch((error) => {
        rootLogger.warn("Failed to send Slack resolved notification:", error);
      });
    }

    runLogger.info(
      `group-affiliates batch completed: events=${outcome.processedEvents} ` +
      `ignored=${outcome.ignoredEvents} trustTxs=${outcome.trustTxHashes.length} ` +
      `untrustTxs=${outcome.untrustTxHashes.length} ` +
      `reputationIneligible=${outcome.ineligibleByReputation.length} dryRun=${effectiveDryRun}`
    );
    return true;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const consecutiveErrors = errorTracker.recordError();
    recordRunError(APP_NAME);
    rootLogger.error(`Consecutive error ${consecutiveErrors} of ${errorsBeforeCrash}`);
    rootLogger.error(formatErrorWithCauses(error));
    if (errorTracker.shouldAlert()) {
      await notifySlackRunError(error, consecutiveErrors);
      setTimeout(() => process.exit(1), 3000).unref();
    }
    throw error;
  }
}

function startReputationReconciliationLoop(): void {
  if (reputationRefreshMs <= 0 || reputationRefreshTimer) {
    return;
  }

  rootLogger.info(`Starting reputation reconciliation loop every ${reputationRefreshMs}ms.`);
  reputationRefreshTimer = setInterval(() => {
    void enqueueExclusive(async () => {
      const effectiveDryRun = getEffectiveDryRun(leaderElection, dryRun);
      await processReputationReconciliation(effectiveDryRun);
    }).catch((error) => {
      rootLogger.error("Reputation reconciliation failed:");
      rootLogger.error(formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
    });
  }, reputationRefreshMs);
}

async function processReputationReconciliation(effectiveDryRun: boolean): Promise<void> {
  const startedAt = Date.now();
  try {
    const outcome = await runReputationReconciliation(
      {circlesRpc, groupService, reputationService, logger: runLogger.child("reputation")},
      {...config, dryRun: effectiveDryRun}
    );
    recordRunSuccess(APP_NAME, Date.now() - startedAt);
    errorTracker.recordSuccess();
    runLogger.info(
      `group-affiliates reputation reconciliation completed: ` +
      `untrustTxs=${outcome.untrustTxHashes.length} ` +
      `reputationIneligible=${outcome.ineligibleByReputation.length} dryRun=${effectiveDryRun}`
    );
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const consecutiveErrors = errorTracker.recordError();
    recordRunError(APP_NAME);
    rootLogger.error(`Consecutive error ${consecutiveErrors} of ${errorsBeforeCrash}`);
    rootLogger.error(formatErrorWithCauses(error));
    if (errorTracker.shouldAlert()) {
      await notifySlackRunError(error, consecutiveErrors);
      setTimeout(() => process.exit(1), 3000).unref();
    }
    throw error;
  }
}

async function loadCursor(stateStore: StateStore | null): Promise<EventCursor> {
  if (!stateStore) {
    return makeInclusiveBlockCursor(startBlock);
  }

  const persisted = await stateStore.load(APP_NAME);
  const transactionIndex = Number(persisted?.data?.transactionIndex);
  const logIndex = Number(persisted?.data?.logIndex);
  if (persisted && Number.isFinite(transactionIndex) && Number.isFinite(logIndex)) {
    const cursor = {
      blockNumber: persisted.lastScannedBlock,
      transactionIndex,
      logIndex
    };
    rootLogger.info(`[state-store] Restored cursor: ${formatCursor(cursor)}`);
    return cursor;
  }

  return makeInclusiveBlockCursor(startBlock);
}

async function saveCursor(stateStore: StateStore | null, cursor: EventCursor): Promise<void> {
  if (!stateStore) {
    return;
  }

  await stateStore.save(APP_NAME, cursor.blockNumber, {
    transactionIndex: cursor.transactionIndex,
    logIndex: cursor.logIndex
  });
  runLogger.info(`[state-store] Saved cursor: ${formatCursor(cursor)}`);
}

function createDryRunGroupService(simulationService?: IGroupService): IGroupService {
  const notAvailable = async () => {
    throw new Error("Group service is not available in dry-run mode");
  };
  return {
    trustBatchWithConditions: notAvailable,
    untrustBatch: notAvailable,
    fetchGroupOwnerAndService: notAvailable,
    simulateTrustBatchWithConditions: simulationService?.simulateTrustBatchWithConditions?.bind(simulationService),
    simulateUntrustBatch: simulationService?.simulateUntrustBatch?.bind(simulationService)
  };
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (listener) {
    try {
      listener.stop();
    } catch (error) {
      rootLogger.warn("Failed to stop AffiliateGroupChanged listener:", error);
    } finally {
      listener = null;
    }
  }
  if (reputationRefreshTimer) {
    clearInterval(reputationRefreshTimer);
    reputationRefreshTimer = null;
  }

  try {
    await leaderElection?.stop();
  } catch (error) {
    rootLogger.warn("Failed to stop leader election:", error);
  }

  try {
    await slackService.notifySlackStartOrCrash(
      `🔄 *Group Affiliates service shutting down*\n\nService received ${signal} signal.`,
      SlackSeverity.INFO
    );
  } catch (error) {
    rootLogger.error("Failed to send shutdown notification:", error);
  }
  process.exit(0);
}

async function notifySlackStartup(): Promise<void> {
  const message = `✅ *Group Affiliates service started*\n\n` +
    `Monitoring AffiliateGroupChanged events and syncing group trust.\n` +
    `- RPC: ${rpcUrl}\n` +
    `- TX RPC: ${txRpcUrl}\n` +
    `- WSS: ${wsUrl}\n` +
    `- Affiliate Registry: ${affiliateRegistryAddress}\n` +
    `- Start Block: ${startBlock}\n` +
    `- Confirmations: ${confirmationBlocks}\n` +
    `- Batch Size: ${batchSize}\n` +
    `- Reputation Mode: ${reputationModeLabel}\n` +
    `- Reputation Threshold: > ${reputationScoreThreshold}\n` +
    `- Reputation Refresh (ms): ${reputationRefreshMs}\n` +
    `- Safe: ${safeAddress || "(not set)"}\n` +
    `- Safe signer configured: ${safeSignerPrivateKey.trim().length > 0}\n` +
    `- Dry Run: ${dryRun}\n` +
    `- Managed Groups: ${DEFAULT_MANAGED_GROUP_ADDRESSES.join(", ")}`;

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

async function notifySlackRunError(error: Error, consecutiveErrors: number): Promise<void> {
  const message = `⚠️ *Group Affiliates run failed* (${consecutiveErrors} consecutive failures)\n\n${formatErrorWithCauses(error)}`;
  try {
    await slackService.notifySlackStartOrCrash(message, SlackSeverity.WARNING);
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack run-error notification:", slackError);
  }
}

function validateConfig(): void {
  if (!affiliateRegistryAddress) {
    throw new Error("GROUP_AFFILIATES_REGISTRY_ADDRESS is required");
  }
  if (!dryRun && safeAddress.trim().length === 0) {
    throw new Error("GROUP_AFFILIATES_SAFE_ADDRESS is required when group-affiliates is not running in dry-run mode");
  }
  if (!dryRun && safeSignerPrivateKey.trim().length === 0) {
    throw new Error("GROUP_AFFILIATES_SAFE_SIGNER_PRIVATE_KEY is required when group-affiliates is not running in dry-run mode");
  }
  if (configuredSignerAddress && safeSignerPrivateKey.trim().length > 0) {
    const signerAddress = new Wallet(safeSignerPrivateKey).address.toLowerCase();
    if (signerAddress !== configuredSignerAddress) {
      throw new Error(
        `Configured GROUP_AFFILIATES_SIGNER_ADDRESS (${configuredSignerAddress}) does not match signer address (${signerAddress}).`
      );
    }
  }
}

function formatCursor(cursor: EventCursor): string {
  return `${cursor.blockNumber}:${cursor.transactionIndex}:${cursor.logIndex}`;
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

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    rootLogger.warn(`Invalid number for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }
  return value;
}

function enqueueExclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = executionQueue.then(task, task);
  executionQueue = next.then(() => undefined, () => undefined);
  return next;
}

start().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("Group Affiliates service crashed:");
  rootLogger.error(formatErrorWithCauses(error));
  void slackService.notifySlackStartOrCrash(
    `🚨 *Group Affiliates service crashed*\n\nLast error: ${error.message}`,
    SlackSeverity.CRITICAL
  ).catch((slackError: unknown) => {
    rootLogger.warn("Failed to send crash notification to Slack:", slackError);
  });
  process.exit(1);
});
