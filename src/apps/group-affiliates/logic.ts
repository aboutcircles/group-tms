import { getAddress } from "ethers";

import { ICirclesRpc } from "../../interfaces/ICirclesRpc";
import { IGroupService } from "../../interfaces/IGroupService";
import { ILoggerService } from "../../interfaces/ILoggerService";
import { AffiliateMap } from "./affiliateMap";
import { AffiliateGroupChangedWithCursor, EventCursor, compareEventCursor } from "./realtime";
import { IReputationService } from "./reputationService";

export const DEFAULT_GROUP_AFFILIATES_BATCH_SIZE = 20;
export const DEFAULT_REPUTATION_SCORE_THRESHOLD = 75;

export const DEFAULT_MANAGED_GROUP_ADDRESSES = [
  "0x4E2564e5df6C1Fb10C1A018538de36E4D5844DE5",
  "0x2709757a543CF1BF4d92586b73d3891438b2589d",
  "0xEEcAe593589a6eE4a12AE64F19420B47F3112Fa9"
] as const;

export type RunConfig = {
  managedGroupAddresses: readonly string[];
  batchSize: number;
  /**
   * Fallback threshold for legacy/test callers. Runtime callers should provide
   * reputationScoreThresholdsByGroup from group profile minRepScore values.
   */
  reputationScoreThreshold: number;
  reputationScoreThresholdsByGroup?: Record<string, number>;
  dryRun?: boolean;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  groupService: IGroupService;
  reputationService: IReputationService;
  logger: ILoggerService;
  /**
   * Optional persistent forward index of human → current affiliate group.
   * When supplied, runForAffiliateEvents updates it as events are applied and
   * runReputationReconciliation uses it to re-trust humans whose reputation
   * has recovered. Omitting it preserves legacy behavior (one-way: untrust-only
   * reconciliation; trust is event-driven only).
   */
  affiliateMap?: AffiliateMap;
};

export type GroupAffiliateOutcome = {
  processedEvents: number;
  ignoredEvents: number;
  affectedGroups: string[];
  trustedByGroup: Record<string, string[]>;
  untrustedByGroup: Record<string, string[]>;
  trustTxHashes: string[];
  untrustTxHashes: string[];
  ineligibleByReputation: string[];
  latestCursor: EventCursor | null;
};

type GroupPlans = Map<string, Set<string>>;

export async function runForAffiliateEvents(
  deps: Deps,
  cfg: RunConfig,
  events: AffiliateGroupChangedWithCursor[]
): Promise<GroupAffiliateOutcome> {
  const { circlesRpc, groupService, reputationService, logger, affiliateMap } = deps;
  const managedGroups = normalizeManagedGroups(cfg.managedGroupAddresses);
  const thresholdsByGroup = normalizeThresholdsByGroup(cfg, managedGroups);
  const sortedEvents = dedupeAndSortEvents(events);
  const latestCursor = sortedEvents.length > 0
    ? sortedEvents[sortedEvents.length - 1].cursor
    : null;

  const desiredTrustedByGroup: GroupPlans = new Map();
  const touchedHumansByGroup: GroupPlans = new Map();
  let ignoredEvents = 0;

  for (const event of sortedEvents) {
    const normalized = normalizeEvent(event);
    if (!normalized || normalized.oldGroup === normalized.newGroup) {
      ignoredEvents += 1;
      continue;
    }

    // Record the latest affiliate-group transition for this human regardless
    // of whether either group is managed — the reconciliation loop needs the
    // full forward index to drive trust re-establishment when reputation
    // recovers, and we may also want to know that a previously-managed
    // affiliate has since moved elsewhere.
    affiliateMap?.set(normalized.human, normalized.newGroup, event.cursor.blockNumber);

    const oldGroupManaged = managedGroups.has(normalized.oldGroup);
    const newGroupManaged = managedGroups.has(normalized.newGroup);
    if (!oldGroupManaged && !newGroupManaged) {
      ignoredEvents += 1;
      continue;
    }

    if (oldGroupManaged) {
      addToSetMap(touchedHumansByGroup, normalized.oldGroup, normalized.human);
      deleteFromSetMap(desiredTrustedByGroup, normalized.oldGroup, normalized.human);
    }

    if (newGroupManaged) {
      addToSetMap(touchedHumansByGroup, normalized.newGroup, normalized.human);
      addToSetMap(desiredTrustedByGroup, normalized.newGroup, normalized.human);
    }
  }

  const affectedGroups = Array.from(touchedHumansByGroup.keys()).sort();
  const touchedHumans = uniqueHumansFromPlans(touchedHumansByGroup);
  const reputationVerdicts = touchedHumans.length > 0
    ? await reputationService.check(touchedHumans, 0)
    : new Map<string, { reputationScore: number | null }>();
  const ineligibleByReputation = uniqueIneligibleHumansByGroup(touchedHumansByGroup, reputationVerdicts, thresholdsByGroup);
  if (ineligibleByReputation.length > 0) {
    logger.info(
      `Reputation gate: ${ineligibleByReputation.length} touched affiliate(s) are not eligible ` +
      `(required reputation_score > group minRepScore).`
    );
  }

  const trustedByGroup: Record<string, string[]> = {};
  const untrustedByGroup: Record<string, string[]> = {};

  for (const group of affectedGroups) {
    const touchedHumans = touchedHumansByGroup.get(group) ?? new Set<string>();
    const threshold = thresholdForGroup(thresholdsByGroup, group);
    const desiredTrusted = new Set(
      Array.from(desiredTrustedByGroup.get(group) ?? new Set<string>())
        .filter((human) => isEligibleForThreshold(reputationVerdicts.get(human), threshold))
    );
    const currentTrustees = new Set(
      (await circlesRpc.fetchAllTrustees(group)).map((address) => normalizeAddress(address)).filter(Boolean) as string[]
    );

    const toUntrust = Array.from(touchedHumans)
      .filter((human) =>
        currentTrustees.has(human) &&
        (!desiredTrusted.has(human) || !isEligibleForThreshold(reputationVerdicts.get(human), threshold))
      )
      .sort();
    const toTrust = Array.from(desiredTrusted)
      .filter((human) => !currentTrustees.has(human))
      .sort();

    untrustedByGroup[group] = toUntrust;
    trustedByGroup[group] = toTrust;
  }

  const totalTrust = Object.values(trustedByGroup).reduce((sum, list) => sum + list.length, 0);
  const totalUntrust = Object.values(untrustedByGroup).reduce((sum, list) => sum + list.length, 0);
  logger.info(
    `Group affiliates decision summary: events=${sortedEvents.length} ignored=${ignoredEvents} ` +
    `affectedGroups=${affectedGroups.length} toUntrust=${totalUntrust} toTrust=${totalTrust}`
  );

  if (cfg.dryRun) {
    await simulatePlannedOperations(groupService, cfg.batchSize, untrustedByGroup, trustedByGroup, logger);
    return {
      processedEvents: sortedEvents.length,
      ignoredEvents,
      affectedGroups,
      trustedByGroup,
      untrustedByGroup,
      trustTxHashes: [],
      untrustTxHashes: [],
      ineligibleByReputation,
      latestCursor
    };
  }

  const { trustTxHashes, untrustTxHashes } = await executePlannedOperations(
    groupService,
    cfg.batchSize,
    untrustedByGroup,
    trustedByGroup,
    logger
  );

  return {
    processedEvents: sortedEvents.length,
    ignoredEvents,
    affectedGroups,
    trustedByGroup,
    untrustedByGroup,
    trustTxHashes,
    untrustTxHashes,
    ineligibleByReputation,
    latestCursor
  };
}

export async function runReputationReconciliation(
  deps: Deps,
  cfg: RunConfig
): Promise<GroupAffiliateOutcome> {
  const { circlesRpc, groupService, reputationService, logger, affiliateMap } = deps;
  const managedGroups = Array.from(normalizeManagedGroups(cfg.managedGroupAddresses)).sort();
  const thresholdsByGroup = normalizeThresholdsByGroup(cfg, new Set(managedGroups));
  const trustedByGroup: Record<string, string[]> = {};
  const untrustedByGroup: Record<string, string[]> = {};
  const trusteesByGroup = new Map<string, Set<string>>();
  const desiredAffiliatesByGroup = new Map<string, Set<string>>();
  const allHumans = new Set<string>();

  for (const group of managedGroups) {
    const trustees = new Set(
      (await circlesRpc.fetchAllTrustees(group))
        .map((address) => normalizeAddress(address))
        .filter(Boolean) as string[]
    );
    trusteesByGroup.set(group, trustees);
    trustedByGroup[group] = [];
    untrustedByGroup[group] = [];
    for (const trustee of trustees) {
      allHumans.add(trustee);
    }

    // Pull current affiliates of this managed group from the persistent map.
    // These are the humans who *should* be trusted (subject to reputation).
    // If no map was supplied, this is empty and behavior collapses to the
    // legacy untrust-only reconciliation.
    const affiliates = (affiliateMap?.getAffiliatesOf(group) ?? [])
      .map((address) => normalizeAddress(address))
      .filter(Boolean) as string[];
    const affiliateSet = new Set(affiliates);
    desiredAffiliatesByGroup.set(group, affiliateSet);
    for (const human of affiliateSet) {
      allHumans.add(human);
    }
  }

  const allHumanAddresses = Array.from(allHumans);
  const reputationVerdicts = allHumanAddresses.length > 0
    ? await reputationService.check(allHumanAddresses, 0)
    : new Map<string, { reputationScore: number | null }>();

  // Reporting line stays anchored to currently-trusted affiliates so the log
  // shape is unchanged for existing dashboards / alerts.
  const currentlyTrustedHumans = new Set<string>();
  for (const trustees of trusteesByGroup.values()) {
    for (const trustee of trustees) currentlyTrustedHumans.add(trustee);
  }
  const ineligibleCurrentlyTrusted = uniqueIneligibleHumansByGroup(trusteesByGroup, reputationVerdicts, thresholdsByGroup);
  if (ineligibleCurrentlyTrusted.length === 0) {
    logger.info(
      `Reputation reconciliation: all ${currentlyTrustedHumans.size} currently trusted affiliate(s) are eligible.`
    );
  } else {
    logger.info(
      `Reputation reconciliation: ${ineligibleCurrentlyTrusted.length}/${currentlyTrustedHumans.size} currently trusted affiliate(s) ` +
      `are not eligible (required reputation_score > group minRepScore).`
    );
  }

  const allRelevantHumansByGroup = mergeGroupPlans(trusteesByGroup, desiredAffiliatesByGroup);
  const ineligibleByReputation = uniqueIneligibleHumansByGroup(allRelevantHumansByGroup, reputationVerdicts, thresholdsByGroup);
  for (const group of managedGroups) {
    const trustees = trusteesByGroup.get(group) ?? new Set<string>();
    const affiliates = desiredAffiliatesByGroup.get(group) ?? new Set<string>();
    const threshold = thresholdForGroup(thresholdsByGroup, group);

    untrustedByGroup[group] = Array.from(trustees)
      .filter((trustee) => !isEligibleForThreshold(reputationVerdicts.get(trustee), threshold))
      .sort();
    trustedByGroup[group] = Array.from(affiliates)
      .filter((human) => isEligibleForThreshold(reputationVerdicts.get(human), threshold) && !trustees.has(human))
      .sort();
  }

  const totalReTrust = Object.values(trustedByGroup).reduce((sum, list) => sum + list.length, 0);
  if (totalReTrust > 0) {
    logger.info(
      `Reputation reconciliation: ${totalReTrust} eligible affiliate(s) missing from trust list — re-trusting.`
    );
  }

  if (cfg.dryRun) {
    await simulatePlannedOperations(groupService, cfg.batchSize, untrustedByGroup, trustedByGroup, logger);
    return {
      processedEvents: 0,
      ignoredEvents: 0,
      affectedGroups: managedGroups,
      trustedByGroup,
      untrustedByGroup,
      trustTxHashes: [],
      untrustTxHashes: [],
      ineligibleByReputation,
      latestCursor: null
    };
  }

  const { trustTxHashes, untrustTxHashes } = await executePlannedOperations(
    groupService,
    cfg.batchSize,
    untrustedByGroup,
    trustedByGroup,
    logger
  );

  return {
    processedEvents: 0,
    ignoredEvents: 0,
    affectedGroups: managedGroups,
    trustedByGroup,
    untrustedByGroup,
    trustTxHashes,
    untrustTxHashes,
    ineligibleByReputation,
    latestCursor: null
  };
}

function normalizeManagedGroups(groups: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const group of groups) {
    const address = normalizeAddress(group);
    if (!address) {
      throw new Error(`Invalid managed group address configured: ${group}`);
    }
    normalized.add(address);
  }
  if (normalized.size === 0) {
    throw new Error("At least one managed group address is required");
  }
  return normalized;
}

function normalizeEvent(event: AffiliateGroupChangedWithCursor): {
  human: string;
  oldGroup: string;
  newGroup: string;
} | null {
  const human = normalizeAddress(event.human);
  const oldGroup = normalizeAddress(event.oldGroup);
  const newGroup = normalizeAddress(event.newGroup);
  if (!human || !oldGroup || !newGroup) {
    return null;
  }
  return { human, oldGroup, newGroup };
}

function normalizeAddress(address: string): string | null {
  try {
    if (address.toLowerCase() === "0x0") {
      return "0x0000000000000000000000000000000000000000";
    }
    return getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

function addToSetMap(map: GroupPlans, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  map.set(key, new Set([value]));
}

function deleteFromSetMap(map: GroupPlans, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.delete(value);
    return;
  }
  map.set(key, new Set<string>());
}

function uniqueHumansFromPlans(plans: GroupPlans): string[] {
  const humans = new Set<string>();
  for (const values of plans.values()) {
    for (const value of values) {
      humans.add(value);
    }
  }
  return Array.from(humans).sort();
}

function normalizeThresholdsByGroup(cfg: RunConfig, managedGroups: Set<string>): Map<string, number> {
  const thresholds = new Map<string, number>();
  for (const group of managedGroups) {
    thresholds.set(group, cfg.reputationScoreThreshold);
  }

  for (const [group, threshold] of Object.entries(cfg.reputationScoreThresholdsByGroup ?? {})) {
    const normalizedGroup = normalizeAddress(group);
    if (!normalizedGroup || !managedGroups.has(normalizedGroup)) {
      continue;
    }
    if (!Number.isFinite(threshold)) {
      throw new Error(`Invalid minRepScore configured for group ${group}: ${threshold}`);
    }
    thresholds.set(normalizedGroup, threshold);
  }
  return thresholds;
}

function thresholdForGroup(thresholdsByGroup: Map<string, number>, group: string): number {
  const normalizedGroup = normalizeAddress(group);
  return normalizedGroup ? thresholdsByGroup.get(normalizedGroup) ?? DEFAULT_REPUTATION_SCORE_THRESHOLD : DEFAULT_REPUTATION_SCORE_THRESHOLD;
}

function isEligibleForThreshold(
  verdict: { reputationScore: number | null } | undefined,
  threshold: number
): boolean {
  return verdict?.reputationScore !== null &&
    verdict?.reputationScore !== undefined &&
    verdict.reputationScore > threshold;
}

function uniqueIneligibleHumansByGroup(
  humansByGroup: GroupPlans,
  reputationVerdicts: Map<string, { reputationScore: number | null }>,
  thresholdsByGroup: Map<string, number>
): string[] {
  const ineligible = new Set<string>();
  for (const [group, humans] of humansByGroup) {
    const threshold = thresholdForGroup(thresholdsByGroup, group);
    for (const human of humans) {
      if (!isEligibleForThreshold(reputationVerdicts.get(human), threshold)) {
        ineligible.add(human);
      }
    }
  }
  return Array.from(ineligible).sort();
}

function mergeGroupPlans(...plans: GroupPlans[]): GroupPlans {
  const merged: GroupPlans = new Map();
  for (const plan of plans) {
    for (const [group, humans] of plan) {
      for (const human of humans) {
        addToSetMap(merged, group, human);
      }
    }
  }
  return merged;
}

async function executePlannedOperations(
  groupService: IGroupService,
  batchSize: number,
  untrustedByGroup: Record<string, string[]>,
  trustedByGroup: Record<string, string[]>,
  logger: ILoggerService
): Promise<{ trustTxHashes: string[]; untrustTxHashes: string[] }> {
  const trustTxHashes: string[] = [];
  const untrustTxHashes: string[] = [];

  for (const [group, addresses] of Object.entries(untrustedByGroup)) {
    for (const batch of chunk(addresses, batchSize)) {
      logger.info(`Untrusting ${batch.length} affiliate(s) from group ${group}: ${batch.join(", ")}`);
      const txHash = await groupService.untrustBatch(group, batch);
      untrustTxHashes.push(txHash);
      logger.info(`Untrust batch submitted for group ${group}: ${txHash}`);
    }
  }

  for (const [group, addresses] of Object.entries(trustedByGroup)) {
    for (const batch of chunk(addresses, batchSize)) {
      logger.info(`Trusting ${batch.length} affiliate(s) in group ${group}: ${batch.join(", ")}`);
      const txHash = await groupService.trustBatchWithConditions(group, batch);
      trustTxHashes.push(txHash);
      logger.info(`Trust batch submitted for group ${group}: ${txHash}`);
    }
  }

  return { trustTxHashes, untrustTxHashes };
}

async function simulatePlannedOperations(
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
        const simulation = await groupService.simulateUntrustBatch(group, batch);
        logger.info(`DRY RUN untrust simulation group=${group}: ok, gasEstimate=${simulation.gasEstimate.toString()}`);
      } else {
        logger.info(`DRY RUN untrust simulation group=${group}: skipped (no signer-backed simulator configured).`);
      }
    }
  }

  for (const [group, addresses] of Object.entries(trustedByGroup)) {
    for (const batch of chunk(addresses, batchSize)) {
      logger.info(`DRY RUN trust group=${group} addresses=${batch.join(", ")}`);
      if (groupService.simulateTrustBatchWithConditions) {
        const simulation = await groupService.simulateTrustBatchWithConditions(group, batch);
        logger.info(`DRY RUN trust simulation group=${group}: ok, gasEstimate=${simulation.gasEstimate.toString()}`);
      } else {
        logger.info(`DRY RUN trust simulation group=${group}: skipped (no signer-backed simulator configured).`);
      }
    }
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const normalizedSize = Math.max(1, size);
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += normalizedSize) {
    result.push(values.slice(i, i + normalizedSize));
  }
  return result;
}

function dedupeAndSortEvents(events: AffiliateGroupChangedWithCursor[]): AffiliateGroupChangedWithCursor[] {
  const seen = new Set<string>();
  const deduped: AffiliateGroupChangedWithCursor[] = [];

  for (const event of events) {
    const key = `${event.txHash}:${event.cursor.blockNumber}:${event.cursor.transactionIndex}:${event.cursor.logIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }

  return deduped.sort((left, right) => compareEventCursor(left.cursor, right.cursor));
}
