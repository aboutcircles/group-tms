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
  runForAffiliateEvents,
  type RunConfig
} from "./logic";
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
const DEFAULT_START_BLOCK = 41_734_312;

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const txRpcUrl = resolveTransactionRpcUrl(rpcUrl);
const affiliateRegistryAddress = (process.env.GROUP_AFFILIATES_REGISTRY_ADDRESS || DEFAULT_AFFILIATE_REGISTRY_ADDRESS).toLowerCase();
const wsUrl = process.env.GROUP_AFFILIATES_WSS_URL || deriveGroupAffiliatesWsUrl(rpcUrl);
const startBlock = parseEnvInt("GROUP_AFFILIATES_START_BLOCK", DEFAULT_START_BLOCK);
const confirmationBlocks = parseEnvInt("CONFIRMATION_BLOCKS", 2);
const batchSize = parseEnvInt("GROUP_AFFILIATES_BATCH_SIZE", DEFAULT_GROUP_AFFILIATES_BATCH_SIZE);
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

let leaderElection: LeaderElection | null = null;
let listener: AffiliateGroupChangedListenerHandle | null = null;
let groupService: IGroupService;
let executionQueue: Promise<void> = Promise.resolve();

const config: RunConfig = {
  managedGroupAddresses: DEFAULT_MANAGED_GROUP_ADDRESSES,
  batchSize,
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

async function processEvents(
  events: AffiliateGroupChangedWithCursor[],
  effectiveDryRun: boolean
): Promise<boolean> {
  if (events.length === 0) {
    runLogger.info("No group affiliate events to process.");
    recordRunSuccess(APP_NAME, 0);
    return !effectiveDryRun;
  }

  const startedAt = Date.now();
  try {
    const outcome = await runForAffiliateEvents(
      {circlesRpc, groupService, logger: runLogger},
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
      `untrustTxs=${outcome.untrustTxHashes.length} dryRun=${effectiveDryRun}`
    );
    return !effectiveDryRun;
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
