/**
 * READ-ONLY pre-cutover verification tool for community-new.
 *
 * Runs the real reconciler in dry-run and reports, per managed group, exactly
 * which current on-chain members each untrust mode would evict. This is the
 * "0 regressions" proof: before flipping community-new wet, the chosen mode's
 * eviction set must be empty (or intentional).
 *
 * Two report shapes, selected by COMMUNITY_NEW_MEMBERSHIP_SOURCE:
 *   rpc (default) — membership from the staging wishlist RPC; reports add-only /
 *                   union / wishlist evictions (the migration blast radius).
 *   old|hybrid|new — membership rebuilt from chain events (the modes that run on
 *                   prod1). Reports the wishlist-authoritative eviction set —
 *                   i.e. exactly what the worker would untrust once wet. Fees are
 *                   off (feeCapEnabled=false), matching the worker on prod.
 *
 * Makes no on-chain writes. Reads config from the same COMMUNITY_NEW_* env vars
 * as the worker. Run: `npm run diff:community-new` (after `npm run build`).
 */
import {getAddress} from "ethers";

import {IGroupService} from "../../../interfaces/IGroupService";
import {AffiliateGroupsRpcService} from "../../../services/affiliateGroupsRpcService";
import {CirclesRpcService} from "../../../services/circlesRpcService";
import {LoggerService} from "../../../services/loggerService";
import {fetchCurrentBlockNumber} from "../../group-affiliates/realtime";
import {
  BulkReputationService,
  IReputationService,
  ReputationService
} from "../../group-affiliates/reputationService";
import {AffiliateMultiMap} from "../affiliateMultiMap";
import {CommunityGroupProfileService} from "../groupProfileService";
import {
  DEFAULT_COMMUNITY_GROUP_ADDRESSES,
  DEFAULT_COMMUNITY_PAGE_SIZE,
  DEFAULT_FEE_FETCH_CONCURRENCY,
  UntrustMode,
  runCommunityReconciliation
} from "../logic";
import {
  DEFAULT_MULTI_AFFILIATE_REGISTRY_ADDRESS,
  DEFAULT_MULTI_AFFILIATE_REGISTRY_DEPLOY_BLOCK,
  fetchMultiAffiliateEvents
} from "../multiRegistry";
import {
  DEFAULT_OLD_AFFILIATE_REGISTRY_ADDRESS,
  DEFAULT_OLD_AFFILIATE_REGISTRY_START_BLOCK,
  fetchOldRegistryMembersByGroup
} from "../oldRegistryMembers";
import {OldRegistrySource, mergeHybridMembers} from "../oldRegistrySource";
import {resolveCommunityReputationConfig} from "../reputationConfig";

const READONLY_GROUP_SERVICE: IGroupService = {
  trustBatchWithConditions: async () => {
    throw new Error("eviction-diff is read-only: no trust writes");
  },
  untrustBatch: async () => {
    throw new Error("eviction-diff is read-only: no untrust writes");
  },
  fetchGroupOwnerAndService: async () => {
    throw new Error("eviction-diff is read-only: group service lookups not needed");
  }
};

function resolveGroups(): string[] {
  const raw = process.env.COMMUNITY_NEW_GROUP_ADDRESSES;
  const values = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : [...DEFAULT_COMMUNITY_GROUP_ADDRESSES];
  return Array.from(new Set(values.map((value) => getAddress(value).toLowerCase())));
}

function parseAddressSet(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const value of raw.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    set.add(getAddress(value).toLowerCase());
  }
  return set;
}

function parseSource(raw: string | undefined): "rpc" | "registry" | "old" | "hybrid" {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "registry" || value === "new") return "registry";
  if (value === "old") return "old";
  if (value === "hybrid") return "hybrid";
  return "rpc";
}

/** Rebuild the per-group membership override from chain events (old/hybrid/new). */
async function buildChainOverride(
  source: "registry" | "old" | "hybrid",
  groups: string[],
  chainRpcUrl: string,
  logger: LoggerService
): Promise<Record<string, ReadonlySet<string>>> {
  const needOld = source === "old" || source === "hybrid";
  const needNew = source === "registry" || source === "hybrid";
  const testAddresses = parseAddressSet(process.env.COMMUNITY_NEW_TEST_ADDRESSES);

  let oldSource: OldRegistrySource | null = null;
  if (needOld) {
    oldSource = await OldRegistrySource.create({
      chainRpcUrl,
      registryAddress: process.env.COMMUNITY_NEW_OLD_REGISTRY_ADDRESS || DEFAULT_OLD_AFFILIATE_REGISTRY_ADDRESS,
      startBlock: parseIntEnv("COMMUNITY_NEW_OLD_REGISTRY_START_BLOCK", DEFAULT_OLD_AFFILIATE_REGISTRY_START_BLOCK),
      logger,
      stateStore: null,
      enableWss: false
    });
    await oldSource.init();
  }

  let multiMap: AffiliateMultiMap | null = null;
  if (needNew) {
    const registryAddress = process.env.COMMUNITY_NEW_REGISTRY_ADDRESS || DEFAULT_MULTI_AFFILIATE_REGISTRY_ADDRESS;
    const deployBlock = parseIntEnv("COMMUNITY_NEW_REGISTRY_DEPLOY_BLOCK", DEFAULT_MULTI_AFFILIATE_REGISTRY_DEPLOY_BLOCK);
    const head = await fetchCurrentBlockNumber(chainRpcUrl);
    multiMap = new AffiliateMultiMap(deployBlock - 1);
    if (head !== null) {
      const events = await fetchMultiAffiliateEvents(chainRpcUrl, registryAddress, deployBlock, head, logger);
      for (const event of events) {
        if (event.type === "add") multiMap.add(event.avatar, event.group, event.blockNumber);
        else multiMap.remove(event.avatar, event.group, event.blockNumber);
      }
    }
  }

  const override: Record<string, ReadonlySet<string>> = {};
  for (const group of groups) {
    if (source === "old" && oldSource) {
      override[group] = oldSource.getMembersOf(group);
    } else if (source === "registry" && multiMap) {
      override[group] = multiMap.getMembersOf(group);
    } else if (source === "hybrid" && oldSource && multiMap) {
      override[group] = mergeHybridMembers(oldSource.getMembersOf(group), multiMap.getMembersOf(group), testAddresses);
    } else {
      override[group] = new Set();
    }
  }
  return override;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function run(): Promise<void> {
  const logger = new LoggerService(false, "community-new-diff");
  const source = parseSource(process.env.COMMUNITY_NEW_MEMBERSHIP_SOURCE);
  // Mirror the worker's RPC resolution (main.ts): in non-rpc modes trustees +
  // profiles must read the SAME prod chain as membership, never the staging
  // default — else the diff compares prod membership against staging trustees,
  // producing a bogus "0-regression" proof.
  const chainRpcUrl = process.env.RPC_URL || "https://rpc.staging.aboutcircles.com";
  const communityRpcUrl = process.env.COMMUNITY_NEW_RPC_URL
    || (source === "rpc" ? "https://rpc.staging.aboutcircles.com" : chainRpcUrl);
  const groups = resolveGroups();

  const affiliateRpc = new AffiliateGroupsRpcService(communityRpcUrl);
  const circlesRpc = new CirclesRpcService(communityRpcUrl);
  const profileService = new CommunityGroupProfileService(communityRpcUrl);
  const {baseUrl, scoresUrl, useBulk} = resolveCommunityReputationConfig(process.env);
  const reputationService: IReputationService = useBulk
    ? new BulkReputationService(scoresUrl)
    : new ReputationService(baseUrl);

  const minRepScoresByGroup = await profileService.fetchMinRepScores(groups);
  const deps = {affiliateRpc, circlesRpc, groupService: READONLY_GROUP_SERVICE, reputationService, logger};
  const baseCfg = {
    managedGroupAddresses: groups,
    minRepScoresByGroup,
    pageSize: DEFAULT_COMMUNITY_PAGE_SIZE,
    batchSize: 20,
    feeFetchConcurrency: DEFAULT_FEE_FETCH_CONCURRENCY,
    dryRun: true,
    // In dry-run the circuit breaker only warns; keep caps wide so the full
    // would-be-eviction set is computed and reported rather than truncated.
    maxUntrustTotal: Number.MAX_SAFE_INTEGER,
    maxUntrustRatioPerGroup: 1
  };

  const lines: string[] = ["", `=== community-new pre-cutover eviction diff (READ-ONLY, source=${source}) ===`];

  if (source === "rpc") {
    // Legacy staging path: compare add-only / union / wishlist against the RPC wishlist.
    const oldRegistryMembers = await fetchOldRegistryMembersByGroup(chainRpcUrl, groups, {logger});
    const wishlist = await runCommunityReconciliation(deps, {...baseCfg, untrustMode: "wishlist" as UntrustMode});
    const union = await runCommunityReconciliation(deps, {
      ...baseCfg,
      untrustMode: "union" as UntrustMode,
      protectedTrusteesByGroup: oldRegistryMembers
    });
    let totalWishlist = 0;
    let totalUnion = 0;
    for (const group of groups) {
      const trustees = wishlist.currentTrusteesByGroup[group] ?? 0;
      const wl = wishlist.wishlistMembersByGroup[group] ?? 0;
      const oldMembers = oldRegistryMembers[group]?.size ?? 0;
      const wEvict = wishlist.untrustedByGroup[group] ?? [];
      const uEvict = union.untrustedByGroup[group] ?? [];
      totalWishlist += wEvict.length;
      totalUnion += uEvict.length;
      lines.push(
        "",
        `Group ${group}`,
        `  on-chain trustees=${trustees}  wishlist=${wl}  old-registry members=${oldMembers}`,
        `  add-only mode → evictions: 0`,
        `  union mode    → evictions: ${uEvict.length}${uEvict.length ? "  [" + uEvict.join(", ") + "]" : ""}`,
        `  wishlist mode → evictions: ${wEvict.length}${wEvict.length ? "  [" + wEvict.join(", ") + "]" : ""}`
      );
    }
    lines.push(
      "",
      `TOTAL evictions — add-only: 0   union: ${totalUnion}   wishlist: ${totalWishlist}`,
      "Zero-regression cutover requires the chosen mode's eviction set to be empty or intentional.",
      ""
    );
  } else {
    // Prod path: membership rebuilt from chain; report the authoritative eviction set.
    const wishlistOverrideByGroup = await buildChainOverride(source, groups, chainRpcUrl, logger);
    const reputationBypassAddresses = source === "hybrid" && process.env.COMMUNITY_NEW_TEST_BYPASS_REPUTATION === "1"
      ? parseAddressSet(process.env.COMMUNITY_NEW_TEST_ADDRESSES)
      : undefined;
    const result = await runCommunityReconciliation(deps, {
      ...baseCfg,
      untrustMode: "wishlist" as UntrustMode,
      feeCapEnabled: false,
      wishlistOverrideByGroup,
      reputationBypassAddresses
    });
    let totalEvict = 0;
    let totalTrust = 0;
    for (const group of groups) {
      const trustees = result.currentTrusteesByGroup[group] ?? 0;
      const members = result.wishlistMembersByGroup[group] ?? 0;
      const evict = result.untrustedByGroup[group] ?? [];
      const add = result.trustedByGroup[group] ?? [];
      totalEvict += evict.length;
      totalTrust += add.length;
      lines.push(
        "",
        `Group ${group}`,
        `  on-chain trustees=${trustees}  ${source}-members=${members}`,
        `  would UNTRUST: ${evict.length}${evict.length ? "  [" + evict.join(", ") + "]" : ""}`,
        `  would TRUST:   ${add.length}${add.length ? "  [" + add.join(", ") + "]" : ""}`
      );
    }
    lines.push(
      "",
      `TOTAL — untrust: ${totalEvict}   trust: ${totalTrust}  (mode=wishlist, feeCap=off)`,
      "Zero-regression cutover requires the untrust set to be empty or intentional.",
      ""
    );
  }

  // Intentional stdout report (this is a CLI tool, not the worker loop).
  process.stdout.write(lines.join("\n") + "\n");
}

run().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
