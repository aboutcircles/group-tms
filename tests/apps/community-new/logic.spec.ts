import {AffiliateGroupMember, IAffiliateGroupsRpc} from "../../../src/interfaces/IAffiliateGroupsRpc";
import {
  CommunityRunConfig,
  runCommunityReconciliation
} from "../../../src/apps/community-new/logic";
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

class FakeAffiliateRpc implements IAffiliateGroupsRpc {
  wishlistByGroup: Record<string, string[]> = {};
  feesByAvatar: Record<string, number> = {};
  feeRequests: string[] = [];

  async fetchAllGroupMembersWishlist(groupAddress: string): Promise<AffiliateGroupMember[]> {
    return (this.wishlistByGroup[groupAddress] ?? []).map(member);
  }

  async fetchAllGroupMembers(groupAddress: string): Promise<AffiliateGroupMember[]> {
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

    const outcome = await runCommunityReconciliation(deps, config());

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

  it("untrusts a current trustee removed from the wishlist regardless of criteria", async () => {
    const deps = setup();
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [STALE_CONFIRMED];

    const outcome = await runCommunityReconciliation(deps, config());

    expect(outcome.leftByGroup[GROUP_A]).toEqual([STALE_CONFIRMED]);
    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([STALE_CONFIRMED]);
    expect(outcome.ineligible).toEqual([]);
    expect(deps.groupService.calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [STALE_CONFIRMED]}
    ]);
  });

  it("simulates dry-run batches without submitting writes", async () => {
    const deps = setup();
    deps.affiliateRpc.wishlistByGroup[GROUP_A] = [ELIGIBLE, EXISTING];
    deps.circlesRpc.trusteesByTruster[GROUP_A] = [LOW_SCORE];
    deps.affiliateRpc.feesByAvatar = {[ELIGIBLE]: 0, [EXISTING]: 0};
    deps.reputationService.scores = new Map([[ELIGIBLE, 90], [EXISTING, 90]]);

    const outcome = await runCommunityReconciliation(deps, config({batchSize: 1, dryRun: true}));

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
});
