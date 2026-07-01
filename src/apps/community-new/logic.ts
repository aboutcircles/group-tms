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

export type CommunityRunConfig = {
  managedGroupAddresses: readonly string[];
  minRepScoresByGroup: Record<string, number>;
  pageSize: number;
  batchSize: number;
  feeFetchConcurrency: number;
  maxTotalFeePercentage?: number;
  dryRun?: boolean;
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

  const snapshots = await Promise.all(groups.map(async (groupAddress): Promise<GroupSnapshot> => {
    const [wishlistMembers, currentTrustees] = await Promise.all([
      deps.affiliateRpc.fetchAllGroupMembersWishlist(groupAddress, pageSize),
      deps.circlesRpc.fetchAllTrustees(groupAddress)
    ]);
    return {
      groupAddress,
      wishlist: new Set(wishlistMembers.map((member) => normalizeAddress(member.avatarAddress))),
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
    fetchFeePercentages(deps.affiliateRpc, allWishlistAddresses, feeFetchConcurrency)
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
      const totalFeePercentage = feePercentages.get(avatarAddress);
      if (totalFeePercentage === undefined) {
        throw new Error(`Missing aggregate fee result for ${avatarAddress}`);
      }

      const reasons: EligibilityFailure["reasons"] = [];
      if (reputationScore === null || reputationScore <= threshold) {
        reasons.push("reputation");
      }
      if (totalFeePercentage > maxTotalFeePercentage) {
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
    untrustedByGroup[snapshot.groupAddress] = Array.from(snapshot.currentTrustees)
      .filter((address) => !eligible.has(address))
      .sort();
  }

  const totalTrust = countAddresses(trustedByGroup);
  const totalUntrust = countAddresses(untrustedByGroup);
  const totalLeft = countAddresses(leftByGroup);
  deps.logger.info(
    `Community reconciliation: groups=${groups.length} wishlist=${allWishlistAddresses.length} ` +
    `ineligible=${ineligible.length} left=${totalLeft} toTrust=${totalTrust} toUntrust=${totalUntrust}`
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

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
