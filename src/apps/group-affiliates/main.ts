import { Wallet } from "ethers";

import { IGroupService } from "../../interfaces/IGroupService";
import { SlackSeverity } from "../../interfaces/ISlackService";
import { ConsecutiveErrorTracker } from "../../services/consecutiveErrorTracker";
import { ensureRpcHealthyOrNotify } from "../../services/rpcHealthService";
import { formatErrorWithCauses } from "../../formatError";
import { LoggerService } from "../../services/loggerService";
import { recordRunError, recordRunSuccess, startMetricsServer } from "../../services/metricsService";
import { resolveTransactionRpcUrl } from "../../services/transactionRpc";
import { SafeGroupService } from "../../services/safeGroupService";
import { SlackService } from "../../services/slackService";
import { validateSafeOwnershipOrExit } from "../../services/startupValidation";
import { StateStore } from "../../services/stateStore";
import { CirclesRpcService } from "../../services/circlesRpcService";
import { AffiliateMap } from "./affiliateMap";
import { GroupProfileService, IGroupProfileService } from "./groupProfileService";
import {
  DEFAULT_GROUP_AFFILIATES_BATCH_SIZE,
  DEFAULT_MANAGED_GROUP_ADDRESSES,
  DEFAULT_REPUTATION_SCORE_THRESHOLD,
  runReputationReconciliation,
  runForAffiliateEvents,
  type RunConfig
} from "./logic";
import { BulkReputationService, IReputationService, ReputationService } from "./reputationService";
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
const AFFILIATE_MAP_STATE_KEY = "group-affiliates:affiliate-map";
const BACKFILL_CHUNK_SIZE = 10_000;
const DEFAULT_AFFILIATE_REGISTRY_ADDRESS = "0xca8222e780d046707083f51377b5fd85e2866014";
const DEFAULT_REPUTATION_BASE_URL =
  "https://rpc.aboutcircles.com/analytics/rep_score/groups/score_group/avatars";
const DEFAULT_REPUTATION_SCORES_URL =
  "https://rpc.aboutcircles.com/analytics/rep_score/groups/score_group/scores";
const DEFAULT_GROUP_PROFILE_BASE_URL = "https://staging.circlesubi.network/profiles/profile";
const DEFAULT_START_BLOCK = 46282003;

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const affiliateRegistryAddress = (process.env.GROUP_AFFILIATES_REGISTRY_ADDRESS || DEFAULT_AFFILIATE_REGISTRY_ADDRESS).toLowerCase();
const wsUrl = process.env.GROUP_AFFILIATES_WSS_URL || deriveGroupAffiliatesWsUrl(rpcUrl);
const startBlock = parseEnvInt("GROUP_AFFILIATES_START_BLOCK", DEFAULT_START_BLOCK);
const confirmationBlocks = parseEnvInt("CONFIRMATION_BLOCKS", 2);
const batchSize = parseEnvInt("GROUP_AFFILIATES_BATCH_SIZE", DEFAULT_GROUP_AFFILIATES_BATCH_SIZE);
const configuredReputationBaseUrl = process.env.GROUP_AFFILIATES_REPUTATION_BASE_URL?.trim() ?? "";
const reputationBaseUrl = configuredReputationBaseUrl || DEFAULT_REPUTATION_BASE_URL;
const reputationTimeoutMs = parseEnvInt("GROUP_AFFILIATES_REPUTATION_TIMEOUT_MS", 30_000);
const reputationRefreshMs = parseEnvInt("GROUP_AFFILIATES_REPUTATION_REFRESH_MS", 30 * 60 * 1000);
const reputationConcurrency = parseEnvInt("GROUP_AFFILIATES_REPUTATION_CONCURRENCY", 8);
const groupProfileBaseUrl = process.env.GROUP_AFFILIATES_PROFILE_BASE_URL || DEFAULT_GROUP_PROFILE_BASE_URL;
const groupProfileTimeoutMs = parseEnvInt("GROUP_AFFILIATES_PROFILE_TIMEOUT_MS", 30_000);
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
const derivedReputationScoresUrl = /\/avatars\/*$/.test(reputationBaseUrl)
  ? reputationBaseUrl.replace(/\/avatars\/*$/, "/scores")
  : "";
const reputationScoresUrl =
  process.env.GROUP_AFFILIATES_REPUTATION_SCORES_URL ||
  (configuredReputationBaseUrl.length > 0 ? derivedReputationScoresUrl : DEFAULT_REPUTATION_SCORES_URL);
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
const groupProfileService: IGroupProfileService = new GroupProfileService(groupProfileBaseUrl, groupProfileTimeoutMs);

let listener: AffiliateGroupChangedListenerHandle | null = null;
let groupService: IGroupService;
let executionQueue: Promise<void> = Promise.resolve();
let reputationRefreshTimer: NodeJS.Timeout | null = null;
/**
 * Persistent forward index of human → current affiliate group. Built once
 * from history (see ensureAffiliateMapBackfill), kept current by the event
 * loop (runForAffiliateEvents writes to it), and consumed by the periodic
 * reputation reconciliation to re-trust humans whose score has recovered.
 */
let affiliateMap: AffiliateMap = new AffiliateMap(startBlock - 1);

const config: RunConfig = {
  managedGroupAddresses: DEFAULT_MANAGED_GROUP_ADDRESSES,
  batchSize,
  reputationScoreThreshold: DEFAULT_REPUTATION_SCORE_THRESHOLD,
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

  await validateSafeOwnershipOrExit({
    validate: groupService.validateSafeOwnership?.bind(groupService),
    appLabel: "Group Affiliates",
    logger: rootLogger,
    slack: slackService
  });

  await notifySlackStartup();

  const stateStore = process.env.LEADER_DB_URL ? new StateStore(process.env.LEADER_DB_URL) : null;
  let cursor = await loadCursor(stateStore);

  try {
    const affiliateMapTargetBlock = await fetchSafeHeadBlockForStartup();
    await ensureAffiliateMapBackfill(stateStore, affiliateMapTargetBlock);
    cursor = await runStartupReplay(stateStore, cursor);
    startRealtimeListener(stateStore, cursor);
    startReputationReconciliationLoop(stateStore);
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

  const shouldAdvance = await processEvents(events);
  const replayCursor = makeHeadCursor(safeHead);
  if (shouldAdvance) {
    await saveCursor(stateStore, replayCursor);
    await saveAffiliateMap(stateStore, replayCursor.blockNumber);
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
        const shouldAdvance = await processEvents(events);
        if (shouldAdvance && events.length > 0) {
          const latest = events[events.length - 1].cursor;
          await saveCursor(stateStore, latest);
          await saveAffiliateMap(stateStore, latest.blockNumber);
        }
        return shouldAdvance;
      });
    }
  });
}

/**
 * Ensure the persistent affiliate map covers the registry's history up to the
 * current safe head before event replay starts. This gives the reconciliation
 * loop a complete current human -> affiliate group index immediately on fresh
 * deployments, while startup replay remains responsible for applying any
 * trust/untrust decisions from the worker cursor forward.
 *
 * The realtime listener keeps the map current going forward, so the cost is an
 * O(history) eth_getLogs paging on first boot only.
 */
async function ensureAffiliateMapBackfill(
  stateStore: StateStore | null,
  targetBlock: number
): Promise<void> {
  const persisted = stateStore ? await AffiliateMap.load(stateStore, AFFILIATE_MAP_STATE_KEY) : null;
  if (persisted) {
    affiliateMap = persisted;
  }

  const target = Math.max(startBlock, targetBlock);
  if (affiliateMap.lastScannedBlock >= target) {
    rootLogger.info(
      `[affiliate-map] Reusing persisted map: entries=${affiliateMap.size()} ` +
      `lastScannedBlock=${affiliateMap.lastScannedBlock} cursor=${target}.`
    );
    return;
  }

  const from = Math.max(startBlock, affiliateMap.lastScannedBlock + 1);
  const to = target;
  if (from > to) {
    affiliateMap.advanceCursor(target);
    return;
  }

  rootLogger.info(
    `[affiliate-map] Backfilling AffiliateGroupChanged history ${from}..${to} ` +
    `in chunks of ${BACKFILL_CHUNK_SIZE} (one-time on fresh deployment).`
  );

  const startedAt = Date.now();
  let nextSaveAt = startedAt + 60_000;
  for (let chunkStart = from; chunkStart <= to; chunkStart += BACKFILL_CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + BACKFILL_CHUNK_SIZE - 1, to);
    const events = await fetchAffiliateGroupChangedEventsBetween(
      rpcUrl,
      affiliateRegistryAddress,
      chunkStart,
      chunkEnd,
      null,
      rootLogger.child("affiliate-map-backfill")
    );
    for (const event of events) {
      affiliateMap.set(event.human, event.newGroup, event.cursor.blockNumber);
    }
    affiliateMap.advanceCursor(chunkEnd);

    // Persist incrementally so a crash mid-backfill doesn't force a full restart.
    if (Date.now() >= nextSaveAt) {
      await saveAffiliateMap(stateStore, affiliateMap.lastScannedBlock);
      nextSaveAt = Date.now() + 60_000;
    }
  }

  await saveAffiliateMap(stateStore, affiliateMap.lastScannedBlock);
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  rootLogger.info(
    `[affiliate-map] Backfill complete: entries=${affiliateMap.size()} ` +
    `lastScannedBlock=${affiliateMap.lastScannedBlock} elapsed=${elapsedSec}s.`
  );
}

async function fetchSafeHeadBlockForStartup(): Promise<number> {
  const head = await fetchCurrentBlockNumber(rpcUrl);
  if (head === null) {
    throw new Error("Failed to fetch current block number for affiliate-map backfill.");
  }
  return Math.max(0, head - confirmationBlocks);
}

async function saveAffiliateMap(stateStore: StateStore | null, observedBlock: number): Promise<void> {
  if (!stateStore) return;
  // Cursor advance is independent of any human→group mutation in the batch,
  // but we want it persisted so subsequent restarts don't re-scan history.
  affiliateMap.advanceCursor(observedBlock);
  try {
    await affiliateMap.save(stateStore, AFFILIATE_MAP_STATE_KEY);
  } catch (error) {
    rootLogger.warn(
      `[affiliate-map] Failed to persist affiliate map: ${(error as Error).message}`
    );
  }
}

async function fetchManagedGroupMinRepScores(): Promise<Record<string, number>> {
  const thresholds = await groupProfileService.fetchMinRepScores(DEFAULT_MANAGED_GROUP_ADDRESSES);
  runLogger.info(
    `Loaded managed group minRepScore values: ${Object.entries(thresholds)
      .map(([group, threshold]) => `${group}=${threshold}`)
      .join(", ")}`
  );
  return thresholds;
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
  events: AffiliateGroupChangedWithCursor[]
): Promise<boolean> {
  if (events.length === 0) {
    runLogger.info("No group affiliate events to process.");
    recordRunSuccess(APP_NAME, 0);
    return true;
  }

  const startedAt = Date.now();
  try {
    const outcome = await runForAffiliateEvents(
      { circlesRpc, groupService, reputationService, logger: runLogger, affiliateMap },
      { ...config, reputationScoreThresholdsByGroup: await fetchManagedGroupMinRepScores() },
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
      `reputationIneligible=${outcome.ineligibleByReputation.length} dryRun=${dryRun}`
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

function startReputationReconciliationLoop(stateStore: StateStore | null): void {
  if (reputationRefreshMs <= 0 || reputationRefreshTimer) {
    return;
  }

  rootLogger.info(`Starting reputation reconciliation loop every ${reputationRefreshMs}ms.`);
  reputationRefreshTimer = setInterval(() => {
    void enqueueExclusive(async () => {
      await processReputationReconciliation(stateStore);
    }).catch((error) => {
      rootLogger.error("Reputation reconciliation failed:");
      rootLogger.error(formatErrorWithCauses(error instanceof Error ? error : new Error(String(error))));
    });
  }, reputationRefreshMs);
}

async function processReputationReconciliation(
  stateStore: StateStore | null
): Promise<void> {
  const startedAt = Date.now();
  try {
    const outcome = await runReputationReconciliation(
      { circlesRpc, groupService, reputationService, logger: runLogger.child("reputation"), affiliateMap },
      { ...config, reputationScoreThresholdsByGroup: await fetchManagedGroupMinRepScores() }
    );
    recordRunSuccess(APP_NAME, Date.now() - startedAt);
    errorTracker.recordSuccess();
    runLogger.info(
      `group-affiliates reputation reconciliation completed: ` +
      `trustTxs=${outcome.trustTxHashes.length} ` +
      `untrustTxs=${outcome.untrustTxHashes.length} ` +
      `reputationIneligible=${outcome.ineligibleByReputation.length} dryRun=${dryRun}`
    );
    // Reconciliation doesn't mutate the affiliate map (it only reads), but we
    // still persist it here on the off chance another batch interleaved.
    await saveAffiliateMap(stateStore, affiliateMap.lastScannedBlock);
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
    `- Group Profile URL: ${groupProfileBaseUrl}\n` +
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
