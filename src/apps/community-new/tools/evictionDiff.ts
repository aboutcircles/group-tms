/**
 * READ-ONLY pre-cutover verification tool for community-new.
 *
 * Runs the real reconciler in dry-run for each untrust mode and reports, per
 * managed group, exactly which current on-chain members each mode would evict.
 * This is the "0 regressions" proof: before flipping community-new wet, the
 * chosen mode's eviction set must be empty (or intentional).
 *
 *   add-only  → always 0 evictions (migration-safe default).
 *   union     → evicts only current members absent from BOTH the new wishlist
 *               and the old registry (truly orphaned / manual trusts).
 *   wishlist  → evicts every current member not eligible on the new wishlist
 *               (the full migration-eviction blast radius).
 *
 * Makes no on-chain writes. Reads config from the same COMMUNITY_NEW_* env vars
 * as the worker. Run: `npm run diff:community-new` (after `npm run build`).
 */
import {getAddress} from "ethers";

import {IGroupService} from "../../../interfaces/IGroupService";
import {AffiliateGroupsRpcService} from "../../../services/affiliateGroupsRpcService";
import {CirclesRpcService} from "../../../services/circlesRpcService";
import {LoggerService} from "../../../services/loggerService";
import {
  BulkReputationService,
  IReputationService,
  ReputationService
} from "../../group-affiliates/reputationService";
import {CommunityGroupProfileService} from "../groupProfileService";
import {
  DEFAULT_COMMUNITY_GROUP_ADDRESSES,
  DEFAULT_COMMUNITY_PAGE_SIZE,
  DEFAULT_FEE_FETCH_CONCURRENCY,
  UntrustMode,
  runCommunityReconciliation
} from "../logic";
import {fetchOldRegistryMembersByGroup} from "../oldRegistryMembers";
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

async function run(): Promise<void> {
  const logger = new LoggerService(false, "community-new-diff");
  const communityRpcUrl = process.env.COMMUNITY_NEW_RPC_URL || "https://rpc.staging.aboutcircles.com";
  const chainRpcUrl = process.env.RPC_URL || communityRpcUrl;
  const groups = resolveGroups();

  const affiliateRpc = new AffiliateGroupsRpcService(communityRpcUrl);
  const circlesRpc = new CirclesRpcService(communityRpcUrl);
  const profileService = new CommunityGroupProfileService(communityRpcUrl);
  const {baseUrl, scoresUrl, useBulk} = resolveCommunityReputationConfig(process.env);
  const reputationService: IReputationService = useBulk
    ? new BulkReputationService(scoresUrl)
    : new ReputationService(baseUrl);

  const minRepScoresByGroup = await profileService.fetchMinRepScores(groups);
  const oldRegistryMembers = await fetchOldRegistryMembersByGroup(chainRpcUrl, groups, {logger});

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
  const deps = {affiliateRpc, circlesRpc, groupService: READONLY_GROUP_SERVICE, reputationService, logger};

  const wishlist = await runCommunityReconciliation(deps, {...baseCfg, untrustMode: "wishlist" as UntrustMode});
  const union = await runCommunityReconciliation(deps, {
    ...baseCfg,
    untrustMode: "union" as UntrustMode,
    protectedTrusteesByGroup: oldRegistryMembers
  });

  let totalWishlist = 0;
  let totalUnion = 0;
  const lines: string[] = ["", "=== community-new pre-cutover eviction diff (READ-ONLY) ==="];
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
  // Intentional stdout report (this is a CLI tool, not the worker loop).
  process.stdout.write(lines.join("\n") + "\n");
}

run().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
