import {AffiliateGroupMember, IAffiliateGroupsRpc} from "../../../src/interfaces/IAffiliateGroupsRpc";
import {
  CommunityRunConfig,
  DEFAULT_FEE_FETCH_CONCURRENCY,
  DEFAULT_UNTRUST_MODE,
  runCommunityReconciliation
} from "../../../src/apps/community-new/logic";
import {mergeProtectedTrustees} from "../../../src/apps/community-new/grandfather";
import {IReputationService, ReputationVerdict} from "../../../src/apps/group-affiliates/reputationService";
import {FakeGroupService, FakeLogger} from "../../../fakes/fakes";
import {FakeCirclesRpc} from "../../../fakes/fakes";

const GROUP_A = "0x4e2564e5df6c1fb10c1a018538de36e4d5844de5";
const GROUP_B = "0x2709757a543cf1bf4d92586b73d3891438b2589d";
const ELIGIBLE = "0x1000000000000000000000000000000000000001";
const EXISTING = "0x2000000000000000000000000000000000000002";
const LOW_SCORE = "0x3000000000000000000000000000000000000003";
const OVER_FEE_CAP = "0x4000000000000000000000000000000000000004";
const STALE_CONFIRMED = "0x5000000000000000000000000000000000000005";
const PROTECTED = "0x6000000000000000000000000000000000000006";
const ORPHAN = "0x7000000000000000000000000000000000000007";

class FakeAffiliateRpc implements IAffiliateGroupsRpc {
  wishlistByGroup: Record<string, string[]> = {};
  feesByAvatar: Record<string, number> = {};
  feeRequests: string[] = [];

  async fetchAllGroupMembersWishlist(groupAddress: string): Promise<AffiliateGroupMember[]> {
    return (this.wishlistByGroup[groupAddress] ?? []).map(member);
  }

  async fetchAllGroupMembers(_groupAddress: string): Promise<AffiliateGroupMember[]> {
    return [];
  }

  async fetchAffiliateGroupFeesPercentage(avatarAddress: string): Promise<number> {
    this.feeRequests.push(avatarAddress);
    const fee = this.feesByAvatar[avatarAddress];
    if (fee === undefined) throw new Error(`No fake fee for ${avatarAddress}`);
    return fee;
  }
}

class FakeReputation implements IReputationService {
  scores = new Map<string, number | null>();

  async check(addresses: string[], threshold: number): Promise<Map<string, ReputationVerdict>> {
    return new Map(addresses.map((address) => {
      const score = this.scores.get(address) ?? null;
      return [address, {
        address,
        reputationScore: score,
        eligible: score !== null && score > threshold
      }];
    }));
  }
}

function member(avatarAddress: string): AffiliateGroupMember {
  return {avatarName: null, avatarAddress, timestamp: 123};
}

function config(overrides: Partial<CommunityRunConfig> = {}): CommunityRunConfig {
  return {
    managedGroupAddresses: [GROUP_A],
    minRepScoresByGroup: {[GROUP_A]: 40},
    pageSize: 500,
    batchSize: 20,
    feeFetchConcurrency: 2,
    ...overrides
  };
}

function setup() {
  return {
    affiliateRpc: new FakeAffiliateRpc(),
    circlesRpc: new FakeCirclesRpc(),
    reputationService: new FakeReputation(),
    groupService: new FakeGroupService(),
    logger: new FakeLogger()
  };
}

describe("runCommunityReconciliation", () => {
  it("uses a conservative default fee-fetch concurrency", () => {
    expect(DEFAULT_FEE_FETCH_CONCURRENCY).toBe(2);
  });

  it("defaults to add-only untrust mode (migration-safe)", () => {
    expect(DEFAULT_UNTRUST_MODE).toBe("add-only");
  });

  it("trusts only wishlist members that pass the group threshold and aggregate fee cap", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE, EXISTING, LOW_SCORE, OVER_FEE_CAP];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [EXISTING, LOW_SCORE, OVER_FEE_CAP];
    deps.affiliateRpc.feesByAvatar = {
      [ELIGIBLE]: 100,
      [EXISTING]: 20,
      [LOW_SCORE]: 10,
      [OVER_FEE_CAP]: 101
    };
    deps.reputationService.scores = new Map([
      [ELIGIBLE, 41],
      [EXISTING, 90],
      [LOW_SCORE, 40],
      [OVER_FEE_CAP, 90]
    ]);

    // `wishlist` mode = the snapshot-authoritative behavior these assertions target.
    // Widen the ratio cap so the circuit breaker (a separate concern) does not
    // fire on this deliberately small fixture (2 of 3 trustees untrusted).
    const outcome = await runCommunityReconciliation(
      deps,
      config({untrustMode: "wishlist", maxUntrustRatioPerGroup: 1})
    );

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([ELIGIBLE]);
    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([LOW_SCORE, OVER_FEE_CAP]);
    expect(outcome.ineligible).toEqual([
      expect.objectContaining({avatarAddress: LOW_SCORE, reasons: ["reputation"]}),
      expect.objectContaining({avatarAddress: OVER_FEE_CAP, reasons: ["fee-cap"]})
    ]);
    expect(deps.groupService.calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [LOW_SCORE, OVER_FEE_CAP]},
      {type: "trust", groupAddress: GROUP_A, trusteeAddresses: [ELIGIBLE]}
    ]);
  });

  it("uses each group's minRepScore and fetches aggregate fees once per avatar", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup = {
      [GROUP_A]: [ELIGIBLE],
      [GROUP_B]: [ELIGIBLE]
    };
    deps.affiliateRpc.feesByAvatar[ELIGIBLE] = 99;
    deps.reputationService.scores.set(ELIGIBLE, 50);

    const outcome = await runCommunityReconciliation(deps, config({
      managedGroupAddresses: [GROUP_A, GROUP_B],
      minRepScoresByGroup: {[GROUP_A]: 40, [GROUP_B]: 50}
    }));

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([ELIGIBLE]);
    expect(outcome.trustedByGroup[GROUP_B]).toEqual([]);
    expect(outcome.ineligible).toEqual([
      expect.objectContaining({groupAddress: GROUP_B, avatarAddress: ELIGIBLE, reasons: ["reputation"]})
    ]);
    expect(deps.affiliateRpc.feeRequests).toEqual([ELIGIBLE]);
  });

  it("supports multi-membership: an eligible avatar is trusted by every group it wishlists", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup = {
      [GROUP_A]: [ELIGIBLE],
      [GROUP_B]: [ELIGIBLE]
    };
    deps.affiliateRpc.feesByAvatar[ELIGIBLE] = 0;
    deps.reputationService.scores.set(ELIGIBLE, 90);

    const outcome = await runCommunityReconciliation(deps, config({
      managedGroupAddresses: [GROUP_A, GROUP_B],
      minRepScoresByGroup: {[GROUP_A]: 40, [GROUP_B]: 40}
    }));

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([ELIGIBLE]);
    expect(outcome.trustedByGroup[GROUP_B]).toEqual([ELIGIBLE]);
  });

  it("wishlist mode untrusts a current trustee absent from a non-empty wishlist", async () => {
    const deps = setup();
    // ELIGIBLE keeps the wishlist non-empty (so the empty-wishlist guard does not fire).
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [ELIGIBLE, STALE_CONFIRMED];
    deps.affiliateRpc.feesByAvatar[ELIGIBLE] = 0;
    deps.reputationService.scores.set(ELIGIBLE, 90);

    const outcome = await runCommunityReconciliation(deps, config({untrustMode: "wishlist"}));

    expect(outcome.leftByGroup[GROUP_A]).toEqual([STALE_CONFIRMED]);
    expect(outcome.trustedByGroup[GROUP_A]).toEqual([]);
    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([STALE_CONFIRMED]);
    expect(deps.groupService.calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [STALE_CONFIRMED]}
    ]);
  });

  it("add-only mode (default) never untrusts, even wishlist-absent trustees", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [STALE_CONFIRMED];
    deps.affiliateRpc.feesByAvatar[ELIGIBLE] = 0;
    deps.reputationService.scores.set(ELIGIBLE, 90);

    const outcome = await runCommunityReconciliation(deps, config());

    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([]);
    expect(outcome.trustedByGroup[GROUP_A]).toEqual([ELIGIBLE]);
    expect(deps.groupService.calls).toEqual([
      {type: "trust", groupAddress: GROUP_A, trusteeAddresses: [ELIGIBLE]}
    ]);
  });

  it("union mode protects old-registry members and untrusts only orphans", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [ELIGIBLE, PROTECTED, ORPHAN];
    deps.affiliateRpc.feesByAvatar[ELIGIBLE] = 0;
    deps.reputationService.scores.set(ELIGIBLE, 90);

    const outcome = await runCommunityReconciliation(deps, config({
      untrustMode: "union",
      protectedTrusteesByGroup: {[GROUP_A]: new Set([PROTECTED])}
    }));

    // PROTECTED is an old-registry member → kept; ORPHAN is on neither source → untrusted.
    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([ORPHAN]);
    expect(outcome.trustedByGroup[GROUP_A]).toEqual([]);
  });

  it("union + grandfather list spares a cutover orphan while still untrusting a real leaver", async () => {
    const deps = setup();
    // PROTECTED is trusted but in neither the wishlist nor the old registry — a
    // cutover orphan we grandfather. ORPHAN is likewise off both sources but NOT
    // grandfathered → it must still be untrusted (leave enforcement intact).
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [ELIGIBLE, PROTECTED, ORPHAN];
    deps.affiliateRpc.feesByAvatar[ELIGIBLE] = 0;
    deps.reputationService.scores.set(ELIGIBLE, 90);

    // Old registry has no members for this group (base is empty); PROTECTED is
    // carried solely by the frozen grandfather list.
    const protectedTrusteesByGroup = mergeProtectedTrustees(
      {[GROUP_A]: new Set<string>()},
      {[GROUP_A]: new Set([PROTECTED])}
    );
    const outcome = await runCommunityReconciliation(deps, config({
      untrustMode: "union",
      protectedTrusteesByGroup
    }));

    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([ORPHAN]);
    expect(outcome.untrustedByGroup[GROUP_A]).not.toContain(PROTECTED);
  });

  it("empty-wishlist guard: never mass-untrusts when the wishlist comes back empty", async () => {
    const deps = setup();
    // No wishlist entries for GROUP_A while it still has trustees.
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [STALE_CONFIRMED, PROTECTED];

    const outcome = await runCommunityReconciliation(deps, config({untrustMode: "wishlist"}));

    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([]);
    expect(deps.groupService.calls).toEqual([]);
  });

  it("untrust circuit breaker throws before writing when the cap is exceeded (wet)", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [ELIGIBLE, STALE_CONFIRMED, ORPHAN];
    deps.affiliateRpc.feesByAvatar[ELIGIBLE] = 0;
    deps.reputationService.scores.set(ELIGIBLE, 90);

    await expect(runCommunityReconciliation(deps, config({
      untrustMode: "wishlist",
      maxUntrustTotal: 1
    }))).rejects.toThrow(/circuit breaker/i);
    expect(deps.groupService.calls).toEqual([]);
  });

  it("untrust circuit breaker only warns in dry-run so the plan stays observable", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [ELIGIBLE, STALE_CONFIRMED, ORPHAN];
    deps.affiliateRpc.feesByAvatar[ELIGIBLE] = 0;
    deps.reputationService.scores.set(ELIGIBLE, 90);

    const outcome = await runCommunityReconciliation(deps, config({
      untrustMode: "wishlist",
      maxUntrustTotal: 1,
      dryRun: true
    }));

    // Untrust arrays are returned lexicographically sorted.
    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([STALE_CONFIRMED, ORPHAN]);
    expect(deps.groupService.calls).toEqual([]);
  });

  it("simulates dry-run batches without submitting writes", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE, EXISTING];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [LOW_SCORE];
    deps.affiliateRpc.feesByAvatar = {[ELIGIBLE]: 0, [EXISTING]: 0};
    deps.reputationService.scores = new Map([[ELIGIBLE, 90], [EXISTING, 90]]);

    const outcome = await runCommunityReconciliation(deps, config({
      batchSize: 1,
      dryRun: true,
      untrustMode: "wishlist"
    }));

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([ELIGIBLE, EXISTING]);
    expect(deps.groupService.calls).toEqual([]);
    expect(deps.groupService.simulations).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [LOW_SCORE]},
      {type: "trust", groupAddress: GROUP_A, trusteeAddresses: [ELIGIBLE]},
      {type: "trust", groupAddress: GROUP_A, trusteeAddresses: [EXISTING]}
    ]);
  });

  it("fails closed before writes when a managed group has no loaded requirement", async () => {
    const deps = setup();

    await expect(runCommunityReconciliation(deps, config({minRepScoresByGroup: {}})))
      .rejects
      .toThrow(`No minRepScore was loaded for managed group ${GROUP_A}`);
    expect(deps.groupService.calls).toEqual([]);
  });

  it("feeCapEnabled=false skips the fee RPC and treats fees as unbounded (old/hybrid/new parity)", async () => {
    const deps = setup();
    // Membership from override (no wishlist RPC); no fees registered → the fake
    // fee RPC would throw if called, proving fetchFeePercentages is skipped.
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [];
    deps.reputationService.scores.set(ELIGIBLE, 90);

    const outcome = await runCommunityReconciliation(deps, config({
      feeCapEnabled: false,
      wishlistOverrideByGroup: {[GROUP_A]: new Set([ELIGIBLE])}
    }));

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([ELIGIBLE]);
    expect(deps.affiliateRpc.feeRequests).toEqual([]);
  });

  it("reputationBypassAddresses trusts a cold-start (score 0) test address in hybrid", async () => {
    const deps = setup();
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [];
    deps.reputationService.scores.set(ELIGIBLE, 0); // below threshold 40

    const outcome = await runCommunityReconciliation(deps, config({
      feeCapEnabled: false,
      wishlistOverrideByGroup: {[GROUP_A]: new Set([ELIGIBLE])},
      reputationBypassAddresses: new Set([ELIGIBLE])
    }));

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([ELIGIBLE]);
    expect(outcome.ineligible).toEqual([]);
  });

  it("without the bypass, a score-0 address stays ineligible (control)", async () => {
    const deps = setup();
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [];
    deps.reputationService.scores.set(ELIGIBLE, 0);

    const outcome = await runCommunityReconciliation(deps, config({
      feeCapEnabled: false,
      wishlistOverrideByGroup: {[GROUP_A]: new Set([ELIGIBLE])}
    }));

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([]);
    expect(outcome.ineligible).toEqual([
      expect.objectContaining({avatarAddress: ELIGIBLE, reasons: ["reputation"]})
    ]);
  });

  it("old-mode override untrusts a trustee absent from the old-registry membership (affiliates parity)", async () => {
    const deps = setup();
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [ELIGIBLE, STALE_CONFIRMED];
    deps.reputationService.scores.set(ELIGIBLE, 90);

    const outcome = await runCommunityReconciliation(deps, config({
      feeCapEnabled: false,
      untrustMode: "wishlist",
      wishlistOverrideByGroup: {[GROUP_A]: new Set([ELIGIBLE])}
    }));

    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([STALE_CONFIRMED]);
    expect(outcome.trustedByGroup[GROUP_A]).toEqual([]);
  });
});
