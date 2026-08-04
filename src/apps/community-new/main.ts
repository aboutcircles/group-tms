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
import {StateStore} from "../../services/stateStore";
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
  DEFAULT_MAX_UNTRUST_RATIO_PER_GROUP,
  DEFAULT_MAX_UNTRUST_TOTAL,
  DEFAULT_UNTRUST_MODE,
  UntrustMode,
  runCommunityReconciliation
} from "./logic";
import {AffiliateMultiMap} from "./affiliateMultiMap";
import {
  DEFAULT_MULTI_AFFILIATE_REGISTRY_ADDRESS,
  DEFAULT_MULTI_AFFILIATE_REGISTRY_DEPLOY_BLOCK,
  MultiAffiliateEvent,
  MultiAffiliateListenerHandle,
  deriveWsUrl,
  fetchMultiAffiliateEvents,
  startMultiAffiliateListener
} from "./multiRegistry";
import {
  DEFAULT_OLD_AFFILIATE_REGISTRY_ADDRESS,
  DEFAULT_OLD_AFFILIATE_REGISTRY_START_BLOCK,
  fetchOldRegistryMembersByGroup
} from "./oldRegistryMembers";
import {
  GRANDFATHER_ENV,
  countGrandfather,
  mergeProtectedTrustees,
  parseGrandfatherAddresses
} from "./grandfather";
import {OldRegistrySource, mergeHybridMembers} from "./oldRegistrySource";
import {resolveCommunityReputationConfig} from "./reputationConfig";

type MembershipSource = "rpc" | "registry" | "old" | "hybrid";

const APP_NAME = "community-new";
const DEFAULT_COMMUNITY_RPC_URL = "https://rpc.staging.aboutcircles.com";

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const logger = new LoggerService(verboseLogging, APP_NAME);
const runLogger = logger.child("run");
const membershipSource = parseMembershipSource(process.env.COMMUNITY_NEW_MEMBERSHIP_SOURCE);
const chainRpcUrl = process.env.RPC_URL || DEFAULT_COMMUNITY_RPC_URL;
// The community RPC serves trustees + profile (minRepScore) reads and, in `rpc`
// mode, the wishlist methods. Those are now served on prod as well as staging
// (renamed …AffiliateGroup…→…Community… on the Nethermind plugin), so `rpc` mode
// is no longer pinned to staging by capability — but the default below points at
// staging deliberately. In old/hybrid/new there is no wishlist dependency at all,
// so the URL must be the same prod chain as RPC_URL — fall back to it (never the
// staging default) so the worker can't read staging trust state on prod and
// untrust against it.
const communityRpcUrl = process.env.COMMUNITY_NEW_RPC_URL
  || (membershipSource === "rpc" ? DEFAULT_COMMUNITY_RPC_URL : chainRpcUrl);
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
const {
  baseUrl: reputationBaseUrl,
  scoresUrl: reputationScoresUrl,
  useBulk: useBulkReputation
} = resolveCommunityReputationConfig(process.env);
const reputationTimeoutMs = parsePositiveInt("COMMUNITY_NEW_REPUTATION_TIMEOUT_MS", 30_000);
const reputationConcurrency = parsePositiveInt("COMMUNITY_NEW_REPUTATION_CONCURRENCY", 8);
const reputationSnapshotTtlMs = parsePositiveInt(
  "COMMUNITY_NEW_REPUTATION_SNAPSHOT_TTL_MS",
  Math.max(pollIntervalMs, 5 * 60 * 1000)
);
const maxUntrustTotal = parsePositiveInt("COMMUNITY_NEW_MAX_UNTRUST_TOTAL", DEFAULT_MAX_UNTRUST_TOTAL);
const maxUntrustRatioPerGroup = parseRatio("COMMUNITY_NEW_MAX_UNTRUST_RATIO", DEFAULT_MAX_UNTRUST_RATIO_PER_GROUP);
const oldRegistryAddress = process.env.COMMUNITY_NEW_OLD_REGISTRY_ADDRESS || DEFAULT_OLD_AFFILIATE_REGISTRY_ADDRESS;
const oldRegistryStartBlock = parsePositiveInt(
  "COMMUNITY_NEW_OLD_REGISTRY_START_BLOCK",
  DEFAULT_OLD_AFFILIATE_REGISTRY_START_BLOCK
);
const ackGroupAffiliatesRetired = process.env.COMMUNITY_NEW_ACK_GROUP_AFFILIATES_RETIRED === "1";
// Test-dev allowlist: in `hybrid` these avatars are governed by the NEW multi
// registry (multi-group), everyone else keeps OLD single-slot prod behavior.
const testAddresses = parseAddressSet(process.env.COMMUNITY_NEW_TEST_ADDRESSES);
// Fresh dev addresses have reputation 0 (cold-start), which fails the rep gate.
// Opt-in bypass so allowlisted test avatars can exercise the new flow in hybrid.
const testBypassReputation = process.env.COMMUNITY_NEW_TEST_BYPASS_REPUTATION === "1";
const needsNewMap = membershipSource === "registry" || membershipSource === "hybrid";
const needsOldMap = membershipSource === "old" || membershipSource === "hybrid";
// Per-member fees come from the wishlist RPC; only enforce them in `rpc` mode.
// old/hybrid/new read the chain directly and, like group-affiliates, apply no fee
// cap — a deliberate parity choice, not an RPC limitation (the fee method is
// served on prod too since the community rename).
const feeCapEnabled = membershipSource === "rpc";
// Every chain-authoritative mode (old/hybrid/new) is a membership source of
// truth, so it must UNTRUST departed/removed members — the `wishlist` policy,
// matching group-affiliates (old) and honoring AffiliateGroupRemoved (new). Only
// the staging `rpc` mode keeps the migration-safe add-only default. The untrust
// circuit breaker still guards a wet run whose eviction set is implausibly large.
const untrustMode = parseUntrustMode(
  process.env.COMMUNITY_NEW_UNTRUST_MODE,
  membershipSource === "rpc" ? DEFAULT_UNTRUST_MODE : "wishlist"
);
// Cutover carve-outs (union mode only): orphans trusted on-chain but absent
// from the registry that feeds the wishlist. They are added to the union
// protected set so an authoritative sweep spares them, while every other member
// keeps full join/leave/rep enforcement. See grandfather.ts.
const grandfatherByGroup = parseGrandfatherAddresses(process.env.COMMUNITY_NEW_GRANDFATHER_ADDRESSES);
const registryAddress = process.env.COMMUNITY_NEW_REGISTRY_ADDRESS || DEFAULT_MULTI_AFFILIATE_REGISTRY_ADDRESS;
const registryDeployBlock = parsePositiveInt(
  "COMMUNITY_NEW_REGISTRY_DEPLOY_BLOCK",
  DEFAULT_MULTI_AFFILIATE_REGISTRY_DEPLOY_BLOCK
);
const wssUrl = process.env.COMMUNITY_NEW_WSS_URL || deriveWsUrl(chainRpcUrl);
const enableWss = process.env.COMMUNITY_NEW_ENABLE_WSS === "1";
const oldWssUrl = process.env.COMMUNITY_NEW_OLD_WSS_URL || undefined;
const enableOldWss = process.env.COMMUNITY_NEW_OLD_ENABLE_WSS === "1";
const stateDbUrl = process.env.LEADER_DB_URL || "";
const MULTI_MAP_STATE_KEY = "community-new:multi-affiliate-map";
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
const reputationService: IReputationService = useBulkReputation
  ? new BulkReputationService(reputationScoresUrl, reputationTimeoutMs, reputationSnapshotTtlMs)
  : new ReputationService(reputationBaseUrl, reputationTimeoutMs, reputationConcurrency);
const slackService = new SlackService(slackWebhookUrl, slackWebhookUrlInfo, slackInfoChannel);
const errorTracker = new ConsecutiveErrorTracker(errorsBeforeCrash);
const groupService = createGroupService();

const stateStore = membershipSource !== "rpc" && stateDbUrl.length > 0 ? new StateStore(stateDbUrl) : null;
let multiMap: AffiliateMultiMap | null = null;
let multiListener: MultiAffiliateListenerHandle | null = null;
let oldSource: OldRegistrySource | null = null;
let shuttingDown = false;

function applyMultiEvents(map: AffiliateMultiMap, events: MultiAffiliateEvent[]): void {
  for (const event of events) {
    if (event.type === "add") map.add(event.avatar, event.group, event.blockNumber);
    else map.remove(event.avatar, event.group, event.blockNumber);
  }
}

async function persistMultiMap(map: AffiliateMultiMap): Promise<void> {
  if (!stateStore) return;
  try {
    await map.save(stateStore, MULTI_MAP_STATE_KEY);
  } catch (error) {
    logger.warn("Failed to persist multi-affiliate map:", error);
  }
}

async function fetchChainHead(): Promise<number> {
  const response = await fetch(chainRpcUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: []})
  });
  if (!response.ok) throw new Error(`eth_blockNumber failed with HTTP ${response.status}`);
  const payload = await response.json() as {result?: string; error?: {message?: string}};
  if (payload.error) throw new Error(payload.error.message ?? "eth_blockNumber RPC error");
  const head = Number.parseInt(String(payload.result), 16);
  if (!Number.isFinite(head)) throw new Error(`eth_blockNumber returned a non-numeric head: ${payload.result}`);
  return head;
}

/** Incrementally catch the map up to chain head via getLogs and persist it. */
async function refreshMultiMap(map: AffiliateMultiMap): Promise<void> {
  const head = await fetchChainHead();
  const from = Math.max(registryDeployBlock, map.lastScannedBlock + 1);
  if (from > head) return;
  const events = await fetchMultiAffiliateEvents(chainRpcUrl, registryAddress, from, head, runLogger);
  applyMultiEvents(map, events);
  map.advanceCursor(head);
  await persistMultiMap(map);
}

async function initMultiMap(): Promise<void> {
  multiMap = stateStore ? await AffiliateMultiMap.load(stateStore, MULTI_MAP_STATE_KEY) : null;
  if (!multiMap) {
    multiMap = new AffiliateMultiMap(registryDeployBlock - 1);
  }
  logger.info(
    `Backfilling multi-affiliate map from block ` +
    `${Math.max(registryDeployBlock, multiMap.lastScannedBlock + 1)} (registry ${registryAddress})...`
  );
  await refreshMultiMap(multiMap);
  logger.info(`Multi-affiliate map ready: lastScannedBlock=${multiMap.lastScannedBlock}`);

  if (enableWss) {
    const map = multiMap;
    multiListener = startMultiAffiliateListener({
      httpRpcUrl: chainRpcUrl,
      wsUrl: wssUrl,
      registryAddress,
      logger: logger.child("wss"),
      getFromBlock: () => map.lastScannedBlock + 1,
      onEvents: async (events) => {
        applyMultiEvents(map, events);
        if (events.length > 0) {
          map.advanceCursor(events[events.length - 1].blockNumber);
        }
        await persistMultiMap(map);
      }
    });
    logger.info(`Multi-affiliate WSS listener started on ${wssUrl}.`);
  }
}

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

  // The wishlist RPC method is only used when membership comes from the RPC.
  // In `registry` mode membership is read from the on-chain map (fees still use
  // the RPC and fail loudly on their own if the fee method is unavailable).
  if (membershipSource === "rpc") {
    try {
      await affiliateRpc.assertAffiliateMethodsAvailable(managedGroups[0]);
      logger.info("Affiliate wishlist RPC methods available on the configured node.");
    } catch (cause) {
      throw new Error(
        `Community wishlist RPC methods unavailable on ${communityRpcUrl} ` +
        `(circles_getCommunityMembersWishlist, or the pre-rename circles_getAffiliateGroupMembersWishlist). ` +
        `Both staging and prod serve these — check COMMUNITY_NEW_RPC_URL points at a Circles RPC host ` +
        `(not a plain chain RPC), or use COMMUNITY_NEW_MEMBERSHIP_SOURCE=registry to read membership ` +
        `from chain instead.`,
        {cause: asError(cause)}
      );
    }
  }

  if (needsNewMap) {
    await initMultiMap();
  }
  if (needsOldMap) {
    oldSource = await OldRegistrySource.create({
      chainRpcUrl,
      wssUrl: oldWssUrl,
      registryAddress: oldRegistryAddress,
      startBlock: oldRegistryStartBlock,
      logger: logger.child("old-registry"),
      stateStore,
      enableWss: enableOldWss
    });
    await oldSource.init();
    logger.info(`Old-affiliate map ready: lastScannedBlock=${oldSource.lastScannedBlock}`);
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

        // Non-rpc modes: keep the on-chain map(s) current (getLogs catch-up — a
        // WSS backstop) and derive the membership override instead of the RPC.
        let wishlistOverrideByGroup: Record<string, ReadonlySet<string>> | undefined;
        if (membershipSource !== "rpc") {
          if (needsNewMap && multiMap) await refreshMultiMap(multiMap);
          if (needsOldMap && oldSource) await oldSource.refresh();
          wishlistOverrideByGroup = buildWishlistOverride();
        }

        const protectedTrusteesByGroup = untrustMode === "union"
          ? mergeProtectedTrustees(
              await fetchOldRegistryMembersByGroup(chainRpcUrl, managedGroups, {
                registryAddress: oldRegistryAddress,
                fromBlock: oldRegistryStartBlock,
                logger: runLogger
              }),
              grandfatherByGroup
            )
          : undefined;
        const outcome = await runCommunityReconciliation(
          {affiliateRpc, circlesRpc, groupService, reputationService, logger: runLogger},
          {
            managedGroupAddresses: managedGroups,
            minRepScoresByGroup,
            pageSize,
            batchSize,
            feeFetchConcurrency,
            feeCapEnabled,
            dryRun,
            untrustMode,
            protectedTrusteesByGroup,
            maxUntrustTotal,
            maxUntrustRatioPerGroup,
            wishlistOverrideByGroup,
            reputationBypassAddresses:
              membershipSource === "hybrid" && testBypassReputation ? testAddresses : undefined
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
  // Cutover gate (H3): community-new and group-affiliates manage the same three
  // groups through the SAME Safe + signer EOA. Two wet workers on one signer
  // race the nonce (GS026) and fight an untrust war. Refuse to run wet until the
  // operator has retired group-affiliates for these groups and acknowledged it.
  if (!dryRun && !ackGroupAffiliatesRetired) {
    throw new Error(
      "Refusing to run wet: community-new shares a Safe/signer with group-affiliates for these groups. " +
      "Retire group-affiliates for the managed groups first, then set " +
      "COMMUNITY_NEW_ACK_GROUP_AFFILIATES_RETIRED=1 to acknowledge the cutover."
    );
  }
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

  // Grandfather carve-outs are only consulted by union mode; fail loud rather
  // than let an operator believe addresses are protected when the active mode
  // would still evict (wishlist) or already spares everyone (add-only).
  const grandfatherGroups = Object.keys(grandfatherByGroup);
  if (grandfatherGroups.length > 0) {
    if (untrustMode !== "union") {
      throw new Error(
        `${GRANDFATHER_ENV} is only honored in union untrust mode, but ` +
        `COMMUNITY_NEW_UNTRUST_MODE resolves to '${untrustMode}'. Set it to union, or clear the grandfather list.`
      );
    }
    const managed = new Set(managedGroups);
    for (const group of grandfatherGroups) {
      if (!managed.has(group)) {
        throw new Error(
          `${GRANDFATHER_ENV} references group ${group}, which is not in COMMUNITY_NEW_GROUP_ADDRESSES — ` +
          `grandfathering an unmanaged group has no effect (likely a typo).`
        );
      }
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
  logger.info(
    `  - reputationMode=${useBulkReputation ? `bulk (${reputationScoresUrl})` : `per-address (${reputationBaseUrl})`}`
  );
  logger.info(`  - safe=${safeAddress || "(not set)"}`);
  logger.info(`  - membershipSource=${membershipSource}`);
  logger.info(`  - feeCapEnabled=${feeCapEnabled}`);
  if (needsNewMap) {
    logger.info(`  - registry=${registryAddress} (deployBlock=${registryDeployBlock})`);
    logger.info(`  - wss=${enableWss ? wssUrl : "(disabled)"}  statePersistence=${stateStore ? "on" : "off"}`);
  }
  if (needsOldMap) {
    logger.info(`  - oldRegistry=${oldRegistryAddress} (startBlock=${oldRegistryStartBlock})`);
    logger.info(`  - oldWss=${enableOldWss ? (oldWssUrl ?? "(derived from RPC)") : "(disabled)"}`);
  }
  if (membershipSource === "hybrid") {
    logger.info(`  - testAddresses(${testAddresses.size})=${Array.from(testAddresses).join(", ") || "(none)"}`);
    logger.info(`  - testBypassReputation=${testBypassReputation}`);
  }
  logger.info(`  - untrustMode=${untrustMode}`);
  logger.info(`  - maxUntrustTotal=${maxUntrustTotal} maxUntrustRatioPerGroup=${maxUntrustRatioPerGroup}`);
  if (untrustMode === "union") {
    logger.info(`  - unionProtectedFrom=oldRegistry ${oldRegistryAddress} (startBlock=${oldRegistryStartBlock})`);
    logger.info(`  - grandfatherAddresses=${countGrandfather(grandfatherByGroup)} (frozen carve-outs, union-protected)`);
    for (const [group, set] of Object.entries(grandfatherByGroup)) {
      logger.info(`    · ${group}: ${set.size} [${Array.from(set).join(", ")}]`);
    }
  }
  logger.info(`  - ackGroupAffiliatesRetired=${ackGroupAffiliatesRetired}`);
  logger.info(`  - dryRun=${dryRun}`);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (multiListener) {
    try {
      multiListener.stop();
    } catch (error) {
      logger.warn("Failed to stop multi-affiliate listener:", error);
    }
    multiListener = null;
  }
  if (oldSource) {
    oldSource.stop();
    oldSource = null;
  }
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

function parseRatio(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw && raw.trim().length > 0 ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a number in (0, 1], received ${raw ?? value}`);
  }
  return value;
}

function parseUntrustMode(raw: string | undefined, fallback: UntrustMode): UntrustMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value.length === 0) return fallback;
  if (value === "add-only" || value === "union" || value === "wishlist") {
    return value;
  }
  throw new Error(`COMMUNITY_NEW_UNTRUST_MODE must be one of add-only|union|wishlist, received '${raw}'`);
}

function parseMembershipSource(raw: string | undefined): MembershipSource {
  const value = (raw ?? "").trim().toLowerCase();
  if (value.length === 0 || value === "rpc") return "rpc";
  if (value === "registry" || value === "new") return "registry";
  if (value === "old") return "old";
  if (value === "hybrid") return "hybrid";
  throw new Error(
    `COMMUNITY_NEW_MEMBERSHIP_SOURCE must be one of rpc|old|hybrid|new (new=registry), received '${raw}'`
  );
}

function parseAddressSet(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const value of raw.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    set.add(getAddress(value).toLowerCase());
  }
  return set;
}

/** Per-group membership override for the current mode (see {@link MembershipSource}). */
function buildWishlistOverride(): Record<string, ReadonlySet<string>> {
  const override: Record<string, ReadonlySet<string>> = {};
  for (const group of managedGroups) {
    if (membershipSource === "registry" && multiMap) {
      override[group] = multiMap.getMembersOf(group);
    } else if (membershipSource === "old" && oldSource) {
      override[group] = oldSource.getMembersOf(group);
    } else if (membershipSource === "hybrid" && oldSource && multiMap) {
      override[group] = mergeHybridMembers(
        oldSource.getMembersOf(group),
        multiMap.getMembersOf(group),
        testAddresses
      );
    } else {
      override[group] = new Set();
    }
  }
  return override;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void start().catch((cause) => crash("Startup failure", cause));
