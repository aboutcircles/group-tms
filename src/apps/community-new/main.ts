import {getAddress, Wallet} from "ethers";

import {formatErrorWithCauses} from "../../formatError";
import {IGroupService} from "../../interfaces/IGroupService";
import {SlackSeverity} from "../../interfaces/ISlackService";
import {AffiliateGroupsRpcService} from "../../services/affiliateGroupsRpcService";
import {CirclesRpcService} from "../../services/circlesRpcService";
import {ConsecutiveErrorTracker} from "../../services/consecutiveErrorTracker";
import {LoggerService} from "../../services/loggerService";
import {recordRunError, recordRunSuccess, startMetricsServer} from "../../services/metricsService";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";
import {SafeGroupService} from "../../services/safeGroupService";
import {SlackService} from "../../services/slackService";
import {resolveTransactionRpcUrl} from "../../services/transactionRpc";
import {
  BulkReputationService,
  IReputationService,
  ReputationService
} from "../group-affiliates/reputationService";
import {CommunityGroupProfileService} from "./groupProfileService";
import {
  DEFAULT_COMMUNITY_BATCH_SIZE,
  DEFAULT_COMMUNITY_GROUP_ADDRESSES,
  DEFAULT_COMMUNITY_PAGE_SIZE,
  DEFAULT_FEE_FETCH_CONCURRENCY,
  runCommunityReconciliation
} from "./logic";

const APP_NAME = "community-new";
const DEFAULT_COMMUNITY_RPC_URL = "https://rpc.staging.aboutcircles.com";
const DEFAULT_REPUTATION_BASE_URL =
  "https://walrus-app-2-iod58.ondigitalocean.app/aboutcircles-advanced-analytics2/rep_score/groups/gnosis/avatars";

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const logger = new LoggerService(verboseLogging, APP_NAME);
const runLogger = logger.child("run");
const communityRpcUrl = process.env.COMMUNITY_NEW_RPC_URL || DEFAULT_COMMUNITY_RPC_URL;
const chainRpcUrl = process.env.RPC_URL || communityRpcUrl;
const txRpcUrl = resolveTransactionRpcUrl(chainRpcUrl);
const managedGroups = parseGroupAddresses(
  process.env.COMMUNITY_NEW_GROUP_ADDRESSES,
  DEFAULT_COMMUNITY_GROUP_ADDRESSES
);
const pageSize = parsePositiveInt("COMMUNITY_NEW_PAGE_SIZE", DEFAULT_COMMUNITY_PAGE_SIZE, 1000);
const batchSize = parsePositiveInt("COMMUNITY_NEW_BATCH_SIZE", DEFAULT_COMMUNITY_BATCH_SIZE);
const feeFetchConcurrency = parsePositiveInt(
  "COMMUNITY_NEW_FEE_FETCH_CONCURRENCY",
  DEFAULT_FEE_FETCH_CONCURRENCY
);
const pollIntervalMs = Math.max(1_000, parsePositiveInt("COMMUNITY_NEW_POLL_INTERVAL_MS", 10 * 60 * 1000));
const affiliateRpcTimeoutMs = parsePositiveInt("COMMUNITY_NEW_RPC_TIMEOUT_MS", 30_000);
const affiliateRpcMaxPages = parsePositiveInt("COMMUNITY_NEW_RPC_MAX_PAGES", 500);
const profileTimeoutMs = parsePositiveInt("COMMUNITY_NEW_PROFILE_TIMEOUT_MS", 30_000);
const reputationBaseUrl = process.env.COMMUNITY_NEW_REPUTATION_BASE_URL || DEFAULT_REPUTATION_BASE_URL;
const reputationTimeoutMs = parsePositiveInt("COMMUNITY_NEW_REPUTATION_TIMEOUT_MS", 30_000);
const reputationConcurrency = parsePositiveInt("COMMUNITY_NEW_REPUTATION_CONCURRENCY", 8);
const reputationSnapshotTtlMs = parsePositiveInt(
  "COMMUNITY_NEW_REPUTATION_SNAPSHOT_TTL_MS",
  Math.max(pollIntervalMs, 5 * 60 * 1000)
);
const dryRun = process.env.DRY_RUN === "1";
const safeAddress = process.env.COMMUNITY_NEW_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.COMMUNITY_NEW_SAFE_SIGNER_PRIVATE_KEY || "";
const configuredSignerAddress = process.env.COMMUNITY_NEW_SIGNER_ADDRESS || "";
const canSimulate = safeAddress.trim().length > 0 && safeSignerPrivateKey.trim().length > 0;
const errorsBeforeCrash = parsePositiveInt("COMMUNITY_NEW_ERRORS_BEFORE_CRASH", 5);
const slackWebhookUrl = process.env.COMMUNITY_NEW_SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL || "";
const slackWebhookUrlInfo = process.env.SLACK_WEBHOOK_URL_INFO || "";
const slackInfoChannel = process.env.SLACK_INFO_CHANNEL || "";

validateConfig();

const affiliateRpc = new AffiliateGroupsRpcService(
  communityRpcUrl,
  affiliateRpcTimeoutMs,
  affiliateRpcMaxPages
);
const circlesRpc = new CirclesRpcService(communityRpcUrl);
const profileService = new CommunityGroupProfileService(communityRpcUrl, profileTimeoutMs);
const reputationScoresUrl = process.env.COMMUNITY_NEW_REPUTATION_SCORES_URL ||
  (/\/avatars\/*$/.test(reputationBaseUrl)
    ? reputationBaseUrl.replace(/\/avatars\/*$/, "/scores")
    : "");
const useBulkReputation = process.env.COMMUNITY_NEW_REPUTATION_BULK !== "0" && reputationScoresUrl.length > 0;
const reputationService: IReputationService = useBulkReputation
  ? new BulkReputationService(reputationScoresUrl, reputationTimeoutMs, reputationSnapshotTtlMs)
  : new ReputationService(reputationBaseUrl, reputationTimeoutMs, reputationConcurrency);
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
const groupService = createGroupService();

let shuttingDown = false;

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("uncaughtException", (cause) => { void crash("Uncaught exception", cause); });
process.on("unhandledRejection", (cause) => { void crash("Unhandled rejection", cause); });

async function start(): Promise<void> {
  startMetricsServer(APP_NAME);
  if (groupService.validateSafeOwnership) {
    await groupService.validateSafeOwnership();
    logger.info("Safe ownership validation passed.");
  }
  if (!dryRun || canSimulate) {
    await validateManagedGroupServices();
  }

  logConfiguration();
  await notify(
    `✅ *community-new started*\n` +
    `Groups: ${managedGroups.join(", ")}\n` +
    `Community RPC: ${communityRpcUrl}\n` +
    `Dry run: ${dryRun}`,
    SlackSeverity.INFO
  );

  while (!shuttingDown) {
    const startedAt = Date.now();
    try {
      const healthy = await ensureRpcHealthyOrNotify({
        appName: APP_NAME,
        rpcUrl: communityRpcUrl,
        logger
      });
      if (healthy) {
        const minRepScoresByGroup = await profileService.fetchMinRepScores(managedGroups);
        const outcome = await runCommunityReconciliation(
          {affiliateRpc, circlesRpc, groupService, reputationService, logger: runLogger},
          {
            managedGroupAddresses: managedGroups,
            minRepScoresByGroup,
            pageSize,
            batchSize,
            feeFetchConcurrency,
            dryRun
          }
        );
        recordRunSuccess(APP_NAME, Date.now() - startedAt);
        errorTracker.recordSuccess();
        if (errorTracker.wasAlertingAndRecovered()) {
          void slackService.notifySlackResolved("community-new").catch((error) => {
            logger.warn("Failed to send Slack recovery notification:", error);
          });
        }
        runLogger.info(
          `Run complete: trustTxs=${outcome.trustTxHashes.length} ` +
          `untrustTxs=${outcome.untrustTxHashes.length} ineligible=${outcome.ineligible.length} ` +
          `elapsedMs=${Date.now() - startedAt}`
        );
      }
    } catch (cause) {
      const error = asError(cause);
      const consecutiveErrors = errorTracker.recordError();
      recordRunError(APP_NAME);
      logger.error(`Run failed (${consecutiveErrors}/${errorsBeforeCrash} consecutive errors):`);
      logger.error(formatErrorWithCauses(error));
      if (errorTracker.shouldAlert()) {
        await notify(
          `⚠️ *community-new run failed* (${consecutiveErrors} consecutive failures)\n\n` +
          formatErrorWithCauses(error),
          SlackSeverity.WARNING
        );
        setTimeout(() => process.exit(1), 3_000).unref();
        return;
      }
    }

    await delay(pollIntervalMs);
  }
}

function createGroupService(): IGroupService {
  if (!dryRun || canSimulate) {
    return new SafeGroupService(chainRpcUrl, safeSignerPrivateKey, safeAddress, txRpcUrl);
  }

  const unavailable = async (): Promise<never> => {
    throw new Error("Group writes are unavailable in dry-run mode without Safe credentials");
  };
  return {
    trustBatchWithConditions: unavailable,
    untrustBatch: unavailable,
    fetchGroupOwnerAndService: unavailable
  };
}

function validateConfig(): void {
  if (!dryRun && safeAddress.trim().length === 0) {
    throw new Error("COMMUNITY_NEW_SAFE_ADDRESS is required unless DRY_RUN=1");
  }
  if (!dryRun && safeSignerPrivateKey.trim().length === 0) {
    throw new Error("COMMUNITY_NEW_SAFE_SIGNER_PRIVATE_KEY is required unless DRY_RUN=1");
  }
  if (safeAddress.trim().length > 0) {
    getAddress(safeAddress);
  }
  if (configuredSignerAddress.trim().length > 0) {
    if (safeSignerPrivateKey.trim().length === 0) {
      throw new Error("COMMUNITY_NEW_SIGNER_ADDRESS requires COMMUNITY_NEW_SAFE_SIGNER_PRIVATE_KEY");
    }
    const expected = getAddress(configuredSignerAddress).toLowerCase();
    const actual = new Wallet(safeSignerPrivateKey).address.toLowerCase();
    if (expected !== actual) {
      throw new Error(`Configured community signer ${expected} does not match private-key signer ${actual}`);
    }
  }
}

async function validateManagedGroupServices(): Promise<void> {
  const expectedService = getAddress(safeAddress).toLowerCase();
  for (const group of managedGroups) {
    const configured = await groupService.fetchGroupOwnerAndService(group);
    if (configured.service !== expectedService) {
      throw new Error(
        `Managed group ${group} has service ${configured.service}, but COMMUNITY_NEW_SAFE_ADDRESS is ${expectedService}`
      );
    }
  }
  logger.info(`Group service validation passed for ${managedGroups.length} managed group(s).`);
}

function logConfiguration(): void {
  logger.info("Starting community-new with config:");
  logger.info(`  - communityRpcUrl=${communityRpcUrl}`);
  logger.info(`  - chainRpcUrl=${chainRpcUrl}`);
  logger.info(`  - txRpcUrl=${txRpcUrl}`);
  logger.info(`  - groups=${managedGroups.join(",")}`);
  logger.info(`  - pageSize=${pageSize}`);
  logger.info(`  - batchSize=${batchSize}`);
  logger.info(`  - feeFetchConcurrency=${feeFetchConcurrency}`);
  logger.info(`  - pollIntervalMs=${pollIntervalMs}`);
  logger.info(`  - profileSource=${communityRpcUrl} (circles_getProfileByAddressBatch)`);
  logger.info(`  - reputationMode=${useBulkReputation ? "bulk" : "per-address"}`);
  logger.info(`  - safe=${safeAddress || "(not set)"}`);
  logger.info(`  - dryRun=${dryRun}`);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await notify(`🔄 *community-new shutting down* (${signal})`, SlackSeverity.INFO);
  process.exit(0);
}

async function crash(label: string, cause: unknown): Promise<void> {
  const error = asError(cause);
  logger.error(`${label}:`, formatErrorWithCauses(error));
  await notify(`🚨 *community-new crashed*\n\n${formatErrorWithCauses(error)}`, SlackSeverity.CRITICAL);
  process.exit(1);
}

async function notify(message: string, severity: SlackSeverity): Promise<void> {
  try {
    await slackService.notifySlackStartOrCrash(message, severity);
  } catch (error) {
    logger.warn("Failed to send Slack notification:", error);
  }
}

function parseGroupAddresses(raw: string | undefined, fallback: readonly string[]): string[] {
  const values = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : [...fallback];
  if (values.length === 0) {
    throw new Error("COMMUNITY_NEW_GROUP_ADDRESSES must include at least one address");
  }
  return Array.from(new Set(values.map((value) => getAddress(value).toLowerCase())));
}

function parsePositiveInt(name: string, fallback: number, max: number = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  const value = raw && raw.trim().length > 0 ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer in [1, ${max}], received ${raw ?? value}`);
  }
  return value;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void start().catch((cause) => crash("Startup failure", cause));
