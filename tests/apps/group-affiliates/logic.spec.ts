import {FakeCirclesRpc, FakeGroupService, FakeLogger} from "../../../fakes/fakes";
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
});
