import {FakeCirclesRpc, FakeGroupService, FakeLogger} from "../../../fakes/fakes";
import {AffiliateMap} from "../../../src/apps/group-affiliates/affiliateMap";
import {
  DEFAULT_MANAGED_GROUP_ADDRESSES,
  runReputationReconciliation,
  runForAffiliateEvents,
  type Deps,
  type RunConfig
} from "../../../src/apps/group-affiliates/logic";
import {AffiliateGroupChangedWithCursor} from "../../../src/apps/group-affiliates/realtime";
import {IReputationService, ReputationVerdict} from "../../../src/apps/group-affiliates/reputationService";

const [GROUP_A, GROUP_B, GROUP_C] = DEFAULT_MANAGED_GROUP_ADDRESSES.map((address) => address.toLowerCase());
const UNMANAGED = "0x9999999999999999999999999999999999999999";
const HUMAN_A = "0x1000000000000000000000000000000000000001";
const HUMAN_B = "0x1000000000000000000000000000000000000002";

function makeDeps(): Deps {
  const reputationService = new FakeReputationService();
  return {
    circlesRpc: new FakeCirclesRpc(),
    groupService: new FakeGroupService(),
    reputationService,
    logger: new FakeLogger(true)
  };
}

function makeCfg(overrides?: Partial<RunConfig>): RunConfig {
  return {
    managedGroupAddresses: DEFAULT_MANAGED_GROUP_ADDRESSES,
    batchSize: 20,
    reputationScoreThreshold: 40,
    dryRun: false,
    ...overrides
  };
}

class FakeReputationService implements IReputationService {
  scores = new Map<string, number | null>();

  async check(addresses: string[], threshold: number): Promise<Map<string, ReputationVerdict>> {
    const result = new Map<string, ReputationVerdict>();
    for (const address of addresses) {
      const normalized = address.toLowerCase();
      const score = this.scores.has(normalized) ? this.scores.get(normalized)! : 100;
      result.set(normalized, {
        address: normalized,
        reputationScore: score,
        eligible: score !== null && score > threshold
      });
    }
    return result;
  }
}

function event(
  human: string,
  oldGroup: string,
  newGroup: string,
  blockNumber: number,
  transactionIndex = 0,
  logIndex = 0
): AffiliateGroupChangedWithCursor {
  return {
    blockNumber,
    txHash: `0xtx${blockNumber}${transactionIndex}${logIndex}`,
    human,
    oldGroup,
    newGroup,
    cursor: {blockNumber, transactionIndex, logIndex}
  };
}

describe("group-affiliates logic", () => {
  it("trusts a human when they set a managed group as affiliate", async () => {
    const deps = makeDeps();

    await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, UNMANAGED, GROUP_A, 10)
    ]);

    const groupService = deps.groupService as FakeGroupService;
    expect(groupService.calls).toEqual([
      {type: "trust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]}
    ]);
  });

  it("untrusts a human when they switch away from a managed group", async () => {
    const deps = makeDeps();
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [HUMAN_A];

    await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, GROUP_A, UNMANAGED, 10)
    ]);

    const groupService = deps.groupService as FakeGroupService;
    expect(groupService.calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]}
    ]);
  });

  it("untrusts the old managed group before trusting the new managed group", async () => {
    const deps = makeDeps();
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [HUMAN_A];

    await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, GROUP_A, GROUP_B, 10)
    ]);

    const groupService = deps.groupService as FakeGroupService;
    expect(groupService.calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]},
      {type: "trust", groupAddress: GROUP_B, trusteeAddresses: [HUMAN_A]}
    ]);
  });

  it("collapses multiple replayed switches to the final managed group", async () => {
    const deps = makeDeps();
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [HUMAN_A];
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_B] = [];
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_C] = [];

    await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, GROUP_A, GROUP_B, 11),
      event(HUMAN_A, GROUP_B, GROUP_C, 12)
    ]);

    const groupService = deps.groupService as FakeGroupService;
    expect(groupService.calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]},
      {type: "trust", groupAddress: GROUP_C, trusteeAddresses: [HUMAN_A]}
    ]);
  });

  it("ignores unrelated and same-group events", async () => {
    const deps = makeDeps();

    const outcome = await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, UNMANAGED, UNMANAGED, 10),
      event(HUMAN_A, GROUP_A, GROUP_A, 11)
    ]);

    expect((deps.groupService as FakeGroupService).calls).toEqual([]);
    expect(outcome.ignoredEvents).toBe(2);
  });

  it("batches changes and keeps untrust batches before trust batches", async () => {
    const deps = makeDeps();
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [HUMAN_A, HUMAN_B];

    await runForAffiliateEvents(deps, makeCfg({batchSize: 1}), [
      event(HUMAN_B, GROUP_A, UNMANAGED, 10),
      event(HUMAN_A, GROUP_A, GROUP_B, 11),
      event(HUMAN_B, UNMANAGED, GROUP_B, 12)
    ]);

    const calls = (deps.groupService as FakeGroupService).calls;
    expect(calls.map((call) => call.type)).toEqual(["untrust", "untrust", "trust", "trust"]);
    expect(calls[0].groupAddress).toBe(GROUP_A);
    expect(calls[1].groupAddress).toBe(GROUP_A);
    expect(calls[2].groupAddress).toBe(GROUP_B);
    expect(calls[3].groupAddress).toBe(GROUP_B);
  });

  it("supports dry-run mode with simulations and no write calls", async () => {
    const deps = makeDeps();

    await runForAffiliateEvents(deps, makeCfg({dryRun: true}), [
      event(HUMAN_A, UNMANAGED, GROUP_A, 10)
    ]);

    const groupService = deps.groupService as FakeGroupService;
    expect(groupService.calls).toEqual([]);
    expect(groupService.simulations).toEqual([
      {type: "trust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]}
    ]);
  });

  it("does not trust a managed affiliate whose reputation score is at or below threshold", async () => {
    const deps = makeDeps();
    (deps.reputationService as FakeReputationService).scores.set(HUMAN_A, 40);

    const outcome = await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, UNMANAGED, GROUP_A, 10)
    ]);

    expect((deps.groupService as FakeGroupService).calls).toEqual([]);
    expect(outcome.ineligibleByReputation).toEqual([HUMAN_A]);
  });

  it("uses the managed group's minRepScore instead of the fallback threshold for event trusts", async () => {
    const deps = makeDeps();
    (deps.reputationService as FakeReputationService).scores.set(HUMAN_A, 50);

    const outcome = await runForAffiliateEvents(deps, makeCfg({
      reputationScoreThreshold: 40,
      reputationScoreThresholdsByGroup: {
        [GROUP_A]: 60
      }
    }), [
      event(HUMAN_A, UNMANAGED, GROUP_A, 10)
    ]);

    expect((deps.groupService as FakeGroupService).calls).toEqual([]);
    expect(outcome.ineligibleByReputation).toEqual([HUMAN_A]);
  });

  it("untrusts a touched managed affiliate when their reputation score falls below threshold", async () => {
    const deps = makeDeps();
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [HUMAN_A];
    (deps.reputationService as FakeReputationService).scores.set(HUMAN_A, 39.99);

    await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, UNMANAGED, GROUP_A, 10)
    ]);

    expect((deps.groupService as FakeGroupService).calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]}
    ]);
  });

  it("reconciles current trustees whose reputation score falls below threshold", async () => {
    const deps = makeDeps();
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [HUMAN_A, HUMAN_B];
    (deps.reputationService as FakeReputationService).scores.set(HUMAN_A, 41);
    (deps.reputationService as FakeReputationService).scores.set(HUMAN_B, 10);

    const outcome = await runReputationReconciliation(deps, makeCfg());

    expect(outcome.ineligibleByReputation).toEqual([HUMAN_B]);
    expect((deps.groupService as FakeGroupService).calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_B]}
    ]);
  });

  it("uses each managed group's minRepScore during reconciliation", async () => {
    const deps = makeDeps();
    const affiliateMap = new AffiliateMap();
    deps.affiliateMap = affiliateMap;
    affiliateMap.set(HUMAN_A, GROUP_A, 10);
    affiliateMap.set(HUMAN_B, GROUP_B, 10);
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [HUMAN_A];
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_B] = [];
    (deps.reputationService as FakeReputationService).scores.set(HUMAN_A, 50);
    (deps.reputationService as FakeReputationService).scores.set(HUMAN_B, 50);

    const outcome = await runReputationReconciliation(deps, makeCfg({
      reputationScoreThreshold: 40,
      reputationScoreThresholdsByGroup: {
        [GROUP_A]: 60,
        [GROUP_B]: 45
      }
    }));

    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([HUMAN_A]);
    expect(outcome.trustedByGroup[GROUP_B]).toEqual([HUMAN_B]);
    expect((deps.groupService as FakeGroupService).calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]},
      {type: "trust", groupAddress: GROUP_B, trusteeAddresses: [HUMAN_B]}
    ]);
  });

  it("updates the AffiliateMap as events are processed, including unmanaged destinations", async () => {
    const deps = makeDeps();
    const affiliateMap = new AffiliateMap();
    deps.affiliateMap = affiliateMap;

    await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, UNMANAGED, GROUP_A, 10),
      event(HUMAN_B, UNMANAGED, GROUP_A, 11),
      event(HUMAN_A, GROUP_A, UNMANAGED, 12)
    ]);

    // HUMAN_A's latest move is back to UNMANAGED — the map reflects that.
    expect(affiliateMap.getGroup(HUMAN_A)).toBe(UNMANAGED.toLowerCase());
    // HUMAN_B is still affiliated with GROUP_A.
    expect(affiliateMap.getGroup(HUMAN_B)).toBe(GROUP_A);
    expect(affiliateMap.getAffiliatesOf(GROUP_A)).toEqual([HUMAN_B]);
    expect(affiliateMap.lastScannedBlock).toBe(12);
  });

  it("re-trusts an affiliate whose reputation has recovered (via reconciliation)", async () => {
    const deps = makeDeps();
    const affiliateMap = new AffiliateMap();
    deps.affiliateMap = affiliateMap;
    const reputation = deps.reputationService as FakeReputationService;

    // Step 1: human joins managed group while score is BELOW threshold — they
    // are not trusted, but the map records the affiliation.
    reputation.scores.set(HUMAN_A, 10);
    await runForAffiliateEvents(deps, makeCfg(), [
      event(HUMAN_A, UNMANAGED, GROUP_A, 10)
    ]);
    expect((deps.groupService as FakeGroupService).calls).toEqual([]);
    expect(affiliateMap.getGroup(HUMAN_A)).toBe(GROUP_A);

    // Step 2: reputation recovers above threshold. Reconciliation should pick
    // them up via the affiliate map and trust them.
    reputation.scores.set(HUMAN_A, 90);
    const outcome = await runReputationReconciliation(deps, makeCfg());

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([HUMAN_A]);
    expect((deps.groupService as FakeGroupService).calls).toEqual([
      {type: "trust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]}
    ]);
  });

  it("does not re-trust someone whose current affiliate group is no longer managed", async () => {
    const deps = makeDeps();
    const affiliateMap = new AffiliateMap();
    deps.affiliateMap = affiliateMap;

    // Human's current affiliate group is unmanaged — they previously had
    // GROUP_A but moved on.
    affiliateMap.set(HUMAN_A, UNMANAGED, 10);

    const outcome = await runReputationReconciliation(deps, makeCfg());

    expect(outcome.trustedByGroup[GROUP_A] ?? []).toEqual([]);
    expect((deps.groupService as FakeGroupService).calls).toEqual([]);
  });

  it("re-trusts an affiliate whose reputation recovered while leaving ineligible trustees alone", async () => {
    const deps = makeDeps();
    const affiliateMap = new AffiliateMap();
    deps.affiliateMap = affiliateMap;
    const reputation = deps.reputationService as FakeReputationService;

    // HUMAN_A is an affiliate of GROUP_A and just recovered above threshold.
    // HUMAN_B is currently trusted by GROUP_A but their reputation is now low.
    affiliateMap.set(HUMAN_A, GROUP_A, 10);
    affiliateMap.set(HUMAN_B, GROUP_A, 11);
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [HUMAN_B];
    reputation.scores.set(HUMAN_A, 90);
    reputation.scores.set(HUMAN_B, 5);

    const outcome = await runReputationReconciliation(deps, makeCfg());

    expect(outcome.trustedByGroup[GROUP_A]).toEqual([HUMAN_A]);
    expect(outcome.untrustedByGroup[GROUP_A]).toEqual([HUMAN_B]);
    const calls = (deps.groupService as FakeGroupService).calls;
    // Untrust batch should precede trust batch to free trust-list capacity if
    // ever capped, and to match the realtime path's invariant.
    expect(calls).toEqual([
      {type: "untrust", groupAddress: GROUP_A, trusteeAddresses: [HUMAN_B]},
      {type: "trust",   groupAddress: GROUP_A, trusteeAddresses: [HUMAN_A]}
    ]);
  });

  it("ignores reconciliation re-trust when no affiliateMap is supplied (legacy callers)", async () => {
    const deps = makeDeps();
    // Don't set deps.affiliateMap — caller is on the old contract.
    (deps.circlesRpc as FakeCirclesRpc).trusteesByTruster[GROUP_A] = [];

    const outcome = await runReputationReconciliation(deps, makeCfg());

    expect(outcome.trustedByGroup[GROUP_A] ?? []).toEqual([]);
    expect((deps.groupService as FakeGroupService).calls).toEqual([]);
  });
});
