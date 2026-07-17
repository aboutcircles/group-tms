import {getAddress} from "ethers";

import {IAffiliateGroupsRpc} from "../../interfaces/IAffiliateGroupsRpc";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {IGroupService} from "../../interfaces/IGroupService";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IReputationService} from "../group-affiliates/reputationService";

export const DEFAULT_COMMUNITY_BATCH_SIZE = 20;
export const DEFAULT_COMMUNITY_PAGE_SIZE = 500;
export const DEFAULT_FEE_FETCH_CONCURRENCY = 2;
export const MAX_AFFILIATE_FEE_PERCENTAGE = 100;
export const DEFAULT_COMMUNITY_GROUP_ADDRESSES = [
  "0x4E2564e5df6C1Fb10C1A018538de36E4D5844DE5",
  "0x2709757a543CF1BF4d92586b73d3891438b2589d",
  "0xEEcAe593589a6eE4a12AE64F19420B47F3112Fa9"
] as const;

/**
 * How the reconciler treats current on-chain trustees that are absent from the
 * (eligible) wishlist. The featured groups are being migrated off the OLD
 * single-slot affiliate registry onto the NEW multi-affiliate registry that
 * feeds the wishlist; during migration the wishlist is NOT yet a complete
 * membership set, so treating wishlist-absence as "leave" would evict members
 * who joined via the old path.
 *
 * - `add-only`  — never untrust (default, migration-safe). Removal is handled
 *   by the incumbent group-affiliates worker until it is retired.
 * - `union`     — untrust only avatars absent from BOTH the wishlist and the
 *   supplied protected set (old-registry members / current path). Bridges the
 *   two registries so no current member is evicted.
 * - `wishlist`  — the wishlist is authoritative; untrust anyone not eligible.
 *   Only correct once every member has migrated to the new registry. Gated by
 *   the untrust circuit breaker below.
 */
export type UntrustMode = "add-only" | "union" | "wishlist";

export const DEFAULT_UNTRUST_MODE: UntrustMode = "add-only";
/** Circuit breaker: abort the whole run if total untrusts across groups exceed this. */
export const DEFAULT_MAX_UNTRUST_TOTAL = 20;
/** Circuit breaker: abort if a single group would untrust more than this fraction of its trustees. */
export const DEFAULT_MAX_UNTRUST_RATIO_PER_GROUP = 0.5;

export type CommunityRunConfig = {
  managedGroupAddresses: readonly string[];
  minRepScoresByGroup: Record<string, number>;
  pageSize: number;
  batchSize: number;
  feeFetchConcurrency: number;
  maxTotalFeePercentage?: number;
  /**
   * Whether to fetch + enforce the per-member affiliate fee cap. Default true.
   * The fee data comes from `circles_getAffiliateGroupFeesPercentage`, which is
   * only served on the staging RPC. On prod (old/hybrid/new membership sources)
   * this must be false — group-affiliates has no fee cap, and calling the missing
   * method would throw. When false, fees are treated as unbounded (never a reason
   * for ineligibility) and the fee RPC is never called.
   */
  feeCapEnabled?: boolean;
  dryRun?: boolean;
  /** How wishlist-absent trustees are handled. Default {@link DEFAULT_UNTRUST_MODE} (add-only). */
  untrustMode?: UntrustMode;
  /** `union` mode: per-group set of addresses that must never be untrusted (old-registry members / current path). */
  protectedTrusteesByGroup?: Record<string, ReadonlySet<string>>;
  /** Circuit breaker cap on total untrusts per run. Default {@link DEFAULT_MAX_UNTRUST_TOTAL}. */
  maxUntrustTotal?: number;
  /** Circuit breaker cap on per-group untrust fraction. Default {@link DEFAULT_MAX_UNTRUST_RATIO_PER_GROUP}. */
  maxUntrustRatioPerGroup?: number;
  /**
   * Membership source override. When provided for a group, this set (e.g. the
   * on-chain-derived {@link AffiliateMultiMap} members) is used as the wishlist
   * instead of calling the wishlist RPC — removing the dependency on the
   * staging-only `circles_getAffiliateGroupMembersWishlist` method.
   */
  wishlistOverrideByGroup?: Record<string, ReadonlySet<string>>;
  /**
   * Avatars exempt from the reputation gate (test-dev allowlist). Used during the
   * hybrid test period so fresh dev addresses (reputation 0, cold-start) can
   * exercise the new multi-group flow without a qualifying score. The fee cap is
   * already off in the modes this is used in. NEVER set this for real users.
   */
  reputationBypassAddresses?: ReadonlySet<string>;
};

export type CommunityRunDeps = {
  affiliateRpc: IAffiliateGroupsRpc;
  circlesRpc: Pick<ICirclesRpc, "fetchAllTrustees">;
  groupService: IGroupService;
  reputationService: IReputationService;
  logger: ILoggerService;
};

export type EligibilityFailure = {
  groupAddress: string;
  avatarAddress: string;
  reasons: Array<"reputation" | "fee-cap">;
  reputationScore: number | null;
  requiredMinRepScore: number;
  totalFeePercentage: number;
};

export type CommunityRunOutcome = {
  wishlistMembersByGroup: Record<string, number>;
  currentTrusteesByGroup: Record<string, number>;
  leftByGroup: Record<string, string[]>;
  trustedByGroup: Record<string, string[]>;
  untrustedByGroup: Record<string, string[]>;
  trustTxHashes: string[];
  untrustTxHashes: string[];
  ineligible: EligibilityFailure[];
};

type GroupSnapshot = {
  groupAddress: string;
  wishlist: Set<string>;
  currentTrustees: Set<string>;
};

/**
 * Reconciles the bilateral community handshake.
 *
 * The wishlist is the source of intent. An address is trusted only when its
 * reputation is strictly greater than the group's minRepScore and its total
 * committed community fee is at most 100%. Current trustees that become
 * ineligible or disappear from the wishlist are untrusted. Absence from the
 * wishlist is the registry's leave signal and takes precedence over criteria.
 */
export async function runCommunityReconciliation(
  deps: CommunityRunDeps,
  cfg: CommunityRunConfig
): Promise<CommunityRunOutcome> {
  const groups = normalizeGroups(cfg.managedGroupAddresses);
  const thresholds = normalizeThresholds(groups, cfg.minRepScoresByGroup);
  const pageSize = positiveIntegerInRange("pageSize", cfg.pageSize, 1, 1000);
  const batchSize = positiveIntegerInRange("batchSize", cfg.batchSize, 1, Number.MAX_SAFE_INTEGER);
  const feeFetchConcurrency = positiveIntegerInRange(
    "feeFetchConcurrency",
    cfg.feeFetchConcurrency,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const maxTotalFeePercentage = cfg.maxTotalFeePercentage ?? MAX_AFFILIATE_FEE_PERCENTAGE;
  if (!Number.isFinite(maxTotalFeePercentage) || maxTotalFeePercentage < 0) {
    throw new Error(`maxTotalFeePercentage must be a finite non-negative number, received ${maxTotalFeePercentage}`);
  }
  const feeCapEnabled = cfg.feeCapEnabled ?? true;
  const untrustMode = cfg.untrustMode ?? DEFAULT_UNTRUST_MODE;
  const maxUntrustTotal = cfg.maxUntrustTotal ?? DEFAULT_MAX_UNTRUST_TOTAL;
  const maxUntrustRatioPerGroup = cfg.maxUntrustRatioPerGroup ?? DEFAULT_MAX_UNTRUST_RATIO_PER_GROUP;
  const protectedTrusteesByGroup = normalizeProtectedTrustees(cfg.protectedTrusteesByGroup);
  const wishlistOverrideByGroup = normalizeProtectedTrustees(cfg.wishlistOverrideByGroup);
  const reputationBypass = new Set(
    Array.from(cfg.reputationBypassAddresses ?? []).map(normalizeAddress)
  );

  const snapshots = await Promise.all(groups.map(async (groupAddress): Promise<GroupSnapshot> => {
    const wishlistOverride = wishlistOverrideByGroup.get(groupAddress);
    const [wishlistMembers, currentTrustees] = await Promise.all([
      wishlistOverride ? Promise.resolve(null) : deps.affiliateRpc.fetchAllGroupMembersWishlist(groupAddress, pageSize),
      deps.circlesRpc.fetchAllTrustees(groupAddress)
    ]);
    const wishlist = wishlistOverride ?? new Set(
      (wishlistMembers ?? []).map((member) => normalizeAddress(member.avatarAddress))
    );
    return {
      groupAddress,
      wishlist,
      currentTrustees: new Set(currentTrustees.map(normalizeAddress))
    };
  }));

  const allWishlistAddresses = Array.from(new Set(
    snapshots.flatMap((snapshot) => Array.from(snapshot.wishlist))
  )).sort();
  const [reputationVerdicts, feePercentages] = await Promise.all([
    allWishlistAddresses.length > 0
      ? deps.reputationService.check(allWishlistAddresses, 0)
      : new Map(),
    feeCapEnabled
      ? fetchFeePercentages(deps.affiliateRpc, allWishlistAddresses, feeFetchConcurrency)
      : Promise.resolve(new Map<string, number>())
  ]);

  const wishlistMembersByGroup: Record<string, number> = {};
  const currentTrusteesByGroup: Record<string, number> = {};
  const leftByGroup: Record<string, string[]> = {};
  const trustedByGroup: Record<string, string[]> = {};
  const untrustedByGroup: Record<string, string[]> = {};
  const ineligible: EligibilityFailure[] = [];

  for (const snapshot of snapshots) {
    const threshold = thresholds.get(snapshot.groupAddress)!;
    const eligible = new Set<string>();
    wishlistMembersByGroup[snapshot.groupAddress] = snapshot.wishlist.size;
    currentTrusteesByGroup[snapshot.groupAddress] = snapshot.currentTrustees.size;

    for (const avatarAddress of snapshot.wishlist) {
      const verdict = reputationVerdicts.get(avatarAddress);
      const reputationScore = verdict?.reputationScore ?? null;
      const feeResult = feePercentages.get(avatarAddress);
      if (feeCapEnabled && feeResult === undefined) {
        throw new Error(`Missing aggregate fee result for ${avatarAddress}`);
      }
      const totalFeePercentage = feeResult ?? 0;

      const reasons: EligibilityFailure["reasons"] = [];
      if (!reputationBypass.has(avatarAddress) && (reputationScore === null || reputationScore <= threshold)) {
        reasons.push("reputation");
      }
      if (feeCapEnabled && totalFeePercentage > maxTotalFeePercentage) {
        reasons.push("fee-cap");
      }

      if (reasons.length === 0) {
        eligible.add(avatarAddress);
      } else {
        ineligible.push({
          groupAddress: snapshot.groupAddress,
          avatarAddress,
          reasons,
          reputationScore,
          requiredMinRepScore: threshold,
          totalFeePercentage
        });
      }
    }

    leftByGroup[snapshot.groupAddress] = Array.from(snapshot.currentTrustees)
      .filter((address) => !snapshot.wishlist.has(address))
      .sort();

    trustedByGroup[snapshot.groupAddress] = Array.from(eligible)
      .filter((address) => !snapshot.currentTrustees.has(address))
      .sort();

    const rawUntrust = Array.from(snapshot.currentTrustees)
      .filter((address) => !eligible.has(address));
    untrustedByGroup[snapshot.groupAddress] = applyUntrustPolicy(
      snapshot,
      rawUntrust,
      untrustMode,
      protectedTrusteesByGroup.get(snapshot.groupAddress),
      deps.logger
    ).sort();
  }

  assertUntrustWithinCaps(
    untrustedByGroup,
    currentTrusteesByGroup,
    maxUntrustTotal,
    maxUntrustRatioPerGroup,
    !!cfg.dryRun,
    deps.logger
  );

  const totalTrust = countAddresses(trustedByGroup);
  const totalUntrust = countAddresses(untrustedByGroup);
  const totalLeft = countAddresses(leftByGroup);
  deps.logger.info(
    `Community reconciliation: groups=${groups.length} wishlist=${allWishlistAddresses.length} ` +
    `ineligible=${ineligible.length} left=${totalLeft} toTrust=${totalTrust} toUntrust=${totalUntrust} ` +
    `untrustMode=${untrustMode}`
  );

  if (cfg.dryRun) {
    await simulatePlan(deps.groupService, batchSize, untrustedByGroup, trustedByGroup, deps.logger);
    return {
      wishlistMembersByGroup,
      currentTrusteesByGroup,
      leftByGroup,
      trustedByGroup,
      untrustedByGroup,
      trustTxHashes: [],
      untrustTxHashes: [],
      ineligible
    };
  }

  const {trustTxHashes, untrustTxHashes} = await executePlan(
    deps.groupService,
    batchSize,
    untrustedByGroup,
    trustedByGroup,
    deps.logger
  );
  return {
    wishlistMembersByGroup,
    currentTrusteesByGroup,
    leftByGroup,
    trustedByGroup,
    untrustedByGroup,
    trustTxHashes,
    untrustTxHashes,
    ineligible
  };
}

async function fetchFeePercentages(
  affiliateRpc: IAffiliateGroupsRpc,
  addresses: string[],
  concurrency: number
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= addresses.length) return;
      const address = addresses[index];
      const total = await affiliateRpc.fetchAffiliateGroupFeesPercentage(address);
      result.set(address, total);
    }
  };

  const workerCount = Math.min(concurrency, addresses.length);
  await Promise.all(Array.from({length: workerCount}, worker));
  return result;
}

async function executePlan(
  groupService: IGroupService,
  batchSize: number,
  untrustedByGroup: Record<string, string[]>,
  trustedByGroup: Record<string, string[]>,
  logger: ILoggerService
): Promise<{trustTxHashes: string[]; untrustTxHashes: string[]}> {
  const trustTxHashes: string[] = [];
  const untrustTxHashes: string[] = [];

  for (const [group, addresses] of Object.entries(untrustedByGroup)) {
    for (const batch of chunk(addresses, batchSize)) {
      logger.info(`Untrusting ${batch.length} ineligible community member(s) from ${group}: ${batch.join(", ")}`);
      untrustTxHashes.push(await groupService.untrustBatch(group, batch));
    }
  }
  for (const [group, addresses] of Object.entries(trustedByGroup)) {
    for (const batch of chunk(addresses, batchSize)) {
      logger.info(`Trusting ${batch.length} eligible community member(s) in ${group}: ${batch.join(", ")}`);
      trustTxHashes.push(await groupService.trustBatchWithConditions(group, batch));
    }
  }

  return {trustTxHashes, untrustTxHashes};
}

async function simulatePlan(
  groupService: IGroupService,
  batchSize: number,
  untrustedByGroup: Record<string, string[]>,
  trustedByGroup: Record<string, string[]>,
  logger: ILoggerService
): Promise<void> {
  for (const [group, addresses] of Object.entries(untrustedByGroup)) {
    for (const batch of chunk(addresses, batchSize)) {
      logger.info(`DRY RUN untrust group=${group} addresses=${batch.join(", ")}`);
      if (groupService.simulateUntrustBatch) {
        const result = await groupService.simulateUntrustBatch(group, batch);
        logger.info(`DRY RUN untrust simulation group=${group}: ok, gasEstimate=${result.gasEstimate}`);
      }
    }
  }
  for (const [group, addresses] of Object.entries(trustedByGroup)) {
    for (const batch of chunk(addresses, batchSize)) {
      logger.info(`DRY RUN trust group=${group} addresses=${batch.join(", ")}`);
      if (groupService.simulateTrustBatchWithConditions) {
        const result = await groupService.simulateTrustBatchWithConditions(group, batch);
        logger.info(`DRY RUN trust simulation group=${group}: ok, gasEstimate=${result.gasEstimate}`);
      }
    }
  }
}

function normalizeGroups(groups: readonly string[]): string[] {
  const normalized = Array.from(new Set(groups.map(normalizeAddress)));
  if (normalized.length === 0) {
    throw new Error("At least one community group address is required");
  }
  return normalized;
}

function normalizeThresholds(groups: string[], configured: Record<string, number>): Map<string, number> {
  const normalizedConfigured = new Map<string, number>();
  for (const [group, threshold] of Object.entries(configured)) {
    if (!Number.isFinite(threshold)) {
      throw new Error(`Invalid minRepScore for ${group}: ${threshold}`);
    }
    normalizedConfigured.set(normalizeAddress(group), threshold);
  }

  const result = new Map<string, number>();
  for (const group of groups) {
    const threshold = normalizedConfigured.get(group);
    if (threshold === undefined) {
      throw new Error(`No minRepScore was loaded for managed group ${group}`);
    }
    result.set(group, threshold);
  }
  return result;
}

function normalizeAddress(address: string): string {
  return getAddress(address).toLowerCase();
}

function positiveIntegerInRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], received ${value}`);
  }
  return value;
}

function countAddresses(byGroup: Record<string, string[]>): number {
  return Object.values(byGroup).reduce((sum, addresses) => sum + addresses.length, 0);
}

function normalizeProtectedTrustees(
  protectedByGroup: Record<string, ReadonlySet<string>> | undefined
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const [group, addresses] of Object.entries(protectedByGroup ?? {})) {
    result.set(
      normalizeAddress(group),
      new Set(Array.from(addresses).map(normalizeAddress))
    );
  }
  return result;
}

/**
 * Decides which of `rawUntrust` (current trustees no longer eligible) are
 * actually queued for untrust, honoring the empty-wishlist guard and the
 * untrust mode. The empty-wishlist guard is unconditional: a well-formed empty
 * wishlist must never be interpreted as "everyone left" — that is the primary
 * mass-untrust failure mode this worker must not have.
 */
function applyUntrustPolicy(
  snapshot: GroupSnapshot,
  rawUntrust: string[],
  mode: UntrustMode,
  protectedTrustees: Set<string> | undefined,
  logger: ILoggerService
): string[] {
  if (snapshot.wishlist.size === 0 && snapshot.currentTrustees.size > 0) {
    logger.warn(
      `Empty wishlist for ${snapshot.groupAddress} with ${snapshot.currentTrustees.size} ` +
      `current trustee(s) — untrusting nobody this cycle (empty-wishlist guard).`
    );
    return [];
  }

  switch (mode) {
    case "add-only":
      return [];
    case "union": {
      const protectedSet = protectedTrustees ?? new Set<string>();
      return rawUntrust.filter((address) => !protectedSet.has(address));
    }
    case "wishlist":
      return rawUntrust;
  }
}

/**
 * Circuit breaker: refuses to submit an anomalously large untrust set. Trips on
 * either an absolute total across all groups or a per-group fraction of current
 * trustees. In dry-run it only warns (so the plan is still observable); in wet
 * mode it throws before any write, so a sparse/misconfigured wishlist or an
 * unintended `wishlist`-mode cutover cannot mass-evict members.
 */
function assertUntrustWithinCaps(
  untrustedByGroup: Record<string, string[]>,
  currentTrusteesByGroup: Record<string, number>,
  maxTotal: number,
  maxRatioPerGroup: number,
  dryRun: boolean,
  logger: ILoggerService
): void {
  const breaches: string[] = [];

  const total = countAddresses(untrustedByGroup);
  if (total > maxTotal) {
    breaches.push(`total untrust ${total} exceeds cap ${maxTotal}`);
  }
  for (const [group, addresses] of Object.entries(untrustedByGroup)) {
    const trustees = currentTrusteesByGroup[group] ?? 0;
    if (addresses.length > 0 && trustees > 0 && addresses.length / trustees > maxRatioPerGroup) {
      breaches.push(
        `group ${group} would untrust ${addresses.length}/${trustees} ` +
        `(${((addresses.length / trustees) * 100).toFixed(0)}% > ${(maxRatioPerGroup * 100).toFixed(0)}%)`
      );
    }
  }
  if (breaches.length === 0) return;

  const message =
    `Untrust circuit breaker tripped: ${breaches.join("; ")}. ` +
    `Refusing to mass-untrust. If this is an intentional migration cutover, raise ` +
    `COMMUNITY_NEW_MAX_UNTRUST_TOTAL / COMMUNITY_NEW_MAX_UNTRUST_RATIO deliberately.`;
  if (dryRun) {
    logger.warn(`[dry-run] ${message}`);
    return;
  }
  throw new Error(message);
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
