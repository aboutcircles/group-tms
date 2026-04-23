import {
  runIncremental,
  runOnce,
  createInitialIncrementalState,
  ALWAYS_TRUSTED_ADDRESSES,
  type Deps,
  type RunConfig,
  type IncrementalState,
} from "../../../src/apps/oic/logic";
import {
  FakeAffiliateGroupEvents,
  FakeChainRpc,
  FakeCirclesRpc,
  FakeGroupService,
  FakeLogger
} from "../../../fakes/fakes";
import { mkAffJoin, mkAffLeave } from "../../../fakes/factories";

const GROUP = "0xgroup000000000000000000000000000000000000";
const META_ORG = "0xmeta00000000000000000000000000000000000";
const REGISTRY = "0xregistry00000000000000000000000000000000";
const DEPLOYED_AT = 1_000_000;
const HEAD = {blockNumber: DEPLOYED_AT + 1_000, timestamp: 200_000};
const SAFE_HEAD = HEAD.blockNumber - 6;

function makeDeps(overrides?: Partial<Deps>): Deps {
  const circlesRpc = new FakeCirclesRpc();
  const chainRpc = new FakeChainRpc(HEAD);
  const groupService = new FakeGroupService();
  const affiliateRegistry = new FakeAffiliateGroupEvents();
  const logger = new FakeLogger(true);

  return {circlesRpc, chainRpc, groupService, affiliateRegistry, logger, ...overrides};
}

function makeCfg(overrides?: Partial<RunConfig>): RunConfig {
  return {
    confirmationBlocks: 6,
    groupAddress: GROUP,
    metaOrgAddress: META_ORG,
    affiliateRegistryAddress: REGISTRY,
    outputBatchSize: 50,
    deployedAtBlock: DEPLOYED_AT,
    dryRun: false,
    ...overrides,
  };
}

describe("oic.runOnce", () => {
  it("trusts desired (affiliates ∩ union(trustees-of MetaOrg trustees)) and untrusts others", async () => {
    const deps = makeDeps();
    const cfg = makeCfg();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const grp = deps.groupService as FakeGroupService;
    const aff = deps.affiliateRegistry as FakeAffiliateGroupEvents;

    // Affiliate events: A joins, B joins then leaves
    const A = "0xA".padEnd(42, "0");
    const B = "0xB".padEnd(42, "0");
    const D = "0xD".padEnd(42, "0");
    aff.events = [
      mkAffJoin(A, GROUP, {blockNumber: DEPLOYED_AT + 10, txHash: "0x1"}),
      mkAffJoin(B, GROUP, {blockNumber: DEPLOYED_AT + 20, txHash: "0x2"}),
      mkAffLeave(B, GROUP, {blockNumber: DEPLOYED_AT + 30, txHash: "0x3"}),
    ];

    // MetaOrg trustees: T1, T2
    const T1 = "0xT1".padEnd(42, "0");
    const T2 = "0xT2".padEnd(42, "0");
    rpc.trusteesByTruster[META_ORG.toLowerCase()] = [T1, T2];
    // T1 trusts A; thus A should be desired (since A is also an affiliate)
    rpc.trusteesByTruster[T1.toLowerCase()] = [A];
    // Group currently trusts B and D
    rpc.trusteesByTruster[GROUP.toLowerCase()] = [B, D];

    await runOnce(deps, cfg);

    // Expect to untrust B and D first; then trust A
    expect(grp.calls.length).toBe(2);
    expect(grp.calls[0].trusteeAddresses.map((x) => x.toLowerCase()).sort()).toEqual([B, D].map(x => x.toLowerCase()).sort());
    const trusted = grp.calls[1].trusteeAddresses.map((x) => x.toLowerCase()).sort();
    const expected = [
      A.toLowerCase(),
      ...Array.from(ALWAYS_TRUSTED_ADDRESSES, addr => addr.toLowerCase()),
    ].sort();
    expect(trusted).toEqual(expected);
  });

  it("batches trusts according to outputBatchSize", async () => {
    const deps = makeDeps();
    const cfg = makeCfg({outputBatchSize: 50});
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const grp = deps.groupService as FakeGroupService;
    const aff = deps.affiliateRegistry as FakeAffiliateGroupEvents;

    const addrs = Array.from({length: 120}, (_, i) => `0x${(i + 1).toString(16).padStart(40, "a")}`);
    // Everyone is an affiliate
    aff.events = addrs.map((h, i) => mkAffJoin(h, GROUP, {blockNumber: DEPLOYED_AT + 1 + i, txHash: `0x${i + 1}`}));
    // MetaOrg trustees: T; and T trusts all addrs (second-degree covers all)
    const T = "0xTT".padEnd(42, "0");
    rpc.trusteesByTruster[META_ORG.toLowerCase()] = [T];
    rpc.trusteesByTruster[T.toLowerCase()] = addrs;
    // Group trusts none initially
    rpc.trusteesByTruster[GROUP.toLowerCase()] = [];

    await runOnce(deps, cfg);

    const totalTrusted = addrs.length + ALWAYS_TRUSTED_ADDRESSES.length;
    expect(grp.calls.length).toBe(Math.ceil(totalTrusted / cfg.outputBatchSize));
    expect(grp.calls[0].trusteeAddresses.length).toBe(cfg.outputBatchSize);
    expect(grp.calls[1].trusteeAddresses.length).toBe(cfg.outputBatchSize);
    const expectedFinalBatch = totalTrusted % cfg.outputBatchSize || cfg.outputBatchSize;
    expect(grp.calls[2].trusteeAddresses.length).toBe(expectedFinalBatch);
  });

  it("dryRun only logs and does not call groupService", async () => {
    const deps = makeDeps();
    const cfg = makeCfg({dryRun: true});
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const grp = deps.groupService as FakeGroupService;
    const aff = deps.affiliateRegistry as FakeAffiliateGroupEvents;

    aff.events = [
      mkAffJoin("0xA".padEnd(42, "0"), GROUP, {blockNumber: DEPLOYED_AT + 10, txHash: "0x1"}),
    ];
    const T = "0xTT".padEnd(42, "0");
    rpc.trusteesByTruster[META_ORG.toLowerCase()] = [T];
    rpc.trusteesByTruster[T.toLowerCase()] = ["0xA".padEnd(42, "0")];
    rpc.trusteesByTruster[GROUP.toLowerCase()] = [];

    await runOnce(deps, cfg);
    expect(grp.calls.length).toBe(0);
  });

  it("always trusts whitelisted addresses even without meta org coverage", async () => {
    const deps = makeDeps();
    const cfg = makeCfg();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const grp = deps.groupService as FakeGroupService;

    rpc.trusteesByTruster[META_ORG.toLowerCase()] = [];
    rpc.trusteesByTruster[GROUP.toLowerCase()] = [];

    await runOnce(deps, cfg);

    const expected = Array.from(ALWAYS_TRUSTED_ADDRESSES, addr => addr.toLowerCase()).sort();
    expect(grp.calls.length).toBe(1);
    expect(grp.calls[0].trusteeAddresses.map(x => x.toLowerCase()).sort()).toEqual(expected);
  });

  it("never untrusts whitelisted addresses", async () => {
    const deps = makeDeps();
    const cfg = makeCfg();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const grp = deps.groupService as FakeGroupService;

    const whitelist = Array.from(ALWAYS_TRUSTED_ADDRESSES, addr => addr.toLowerCase());
    const extra = "0xC0FFEE".padEnd(42, "0").toLowerCase();

    rpc.trusteesByTruster[META_ORG.toLowerCase()] = [];
    rpc.trusteesByTruster[GROUP.toLowerCase()] = [...whitelist, extra];

    await runOnce(deps, cfg);

    expect(grp.calls.length).toBe(1);
    expect(grp.calls[0].trusteeAddresses.map(x => x.toLowerCase()).sort()).toEqual([extra]);
  });
});

describe("oic.runIncremental", () => {
  it("createInitialIncrementalState returns the expected shape", async () => {
    const state = createInitialIncrementalState();
    expect(state.initialized).toBe(false);
    expect(state.lastSafeHeadScanned).toBe(0);
    expect(state.affiliates).toBeInstanceOf(Set);
    expect(state.affiliates.size).toBe(0);
  });

  it("maintains affiliate state across runs and advances lastSafeHeadScanned", async () => {
    const deps1 = makeDeps();
    const rpc = deps1.circlesRpc as FakeCirclesRpc;
    const aff = deps1.affiliateRegistry as FakeAffiliateGroupEvents;
    const grp1 = deps1.groupService as FakeGroupService;

    const state: IncrementalState = createInitialIncrementalState();

    // First run: add A and B as affiliates
    const A = "0xA".padEnd(42, "0");
    const B = "0xB".padEnd(42, "0");
    aff.events = [
      mkAffJoin(A, GROUP, {blockNumber: DEPLOYED_AT + 5, txHash: "0x1"}),
      mkAffJoin(B, GROUP, {blockNumber: DEPLOYED_AT + 6, txHash: "0x2"}),
    ];
    rpc.trusteesByTruster[META_ORG.toLowerCase()] = [A, B];
    // Each of A and B (as MetaOrg trustees) trusts themselves, satisfying the second-degree rule
    rpc.trusteesByTruster[A.toLowerCase()] = [A];
    rpc.trusteesByTruster[B.toLowerCase()] = [B];
    rpc.trusteesByTruster[GROUP.toLowerCase()] = [];

    await runIncremental(deps1, makeCfg(), state);

    expect(state.initialized).toBe(true);
    expect(state.lastSafeHeadScanned).toBe(SAFE_HEAD);
    // Group should have trusted A and B
    expect(grp1.calls.length).toBe(1);
    const firstRunTrusted = grp1.calls[0].trusteeAddresses.map(x => x.toLowerCase()).sort();
    const expectedFirstRun = [
      A.toLowerCase(),
      B.toLowerCase(),
      ...Array.from(ALWAYS_TRUSTED_ADDRESSES, addr => addr.toLowerCase()),
    ].sort();
    expect(firstRunTrusted).toEqual(expectedFirstRun);

    // Second run: new head, and event that removes B from affiliates
    const deps2 = makeDeps({chainRpc: new FakeChainRpc({blockNumber: HEAD.blockNumber + 20, timestamp: HEAD.timestamp + 20}), affiliateRegistry: aff});
    const rpc2 = deps2.circlesRpc as FakeCirclesRpc;
    rpc2.trusteesByTruster[META_ORG.toLowerCase()] = [A, B];
    rpc2.trusteesByTruster[A.toLowerCase()] = [A];
    rpc2.trusteesByTruster[B.toLowerCase()] = [B];
    // Simulate group currently trusts both A and B.
    rpc2.trusteesByTruster[GROUP.toLowerCase()] = [
      A,
      B,
      ...Array.from(ALWAYS_TRUSTED_ADDRESSES),
    ];

    // Add a removal event within the new range
    aff.events.push(mkAffLeave(B, GROUP, {blockNumber: SAFE_HEAD + 10, txHash: "0x3"}));

    const grp2 = deps2.groupService as FakeGroupService;
    await runIncremental(deps2, makeCfg(), state);

    // Should untrust B now
    expect(grp2.calls.length).toBe(1);
    expect(grp2.calls[0].trusteeAddresses.map(x => x.toLowerCase())).toEqual([B.toLowerCase()]);
    expect(state.lastSafeHeadScanned).toBe(HEAD.blockNumber + 20 - 6);
  });

  it("no new events still reconciles against current trustees", async () => {
    // Start with state having A as affiliate
    const state: IncrementalState = {initialized: true, lastSafeHeadScanned: SAFE_HEAD, affiliates: new Set(["0xA".padEnd(42, "0").toLowerCase()])};

    // New deps with safeHead not advancing beyond fromBlock
    const head2 = {blockNumber: SAFE_HEAD + 6, timestamp: HEAD.timestamp + 1};
    const deps = makeDeps({chainRpc: new FakeChainRpc(head2)});
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const grp = deps.groupService as FakeGroupService;

    const A = "0xA".padEnd(42, "0");
    const C = "0xC".padEnd(42, "0");
    const T = "0xTT".padEnd(42, "0");
    rpc.trusteesByTruster[META_ORG.toLowerCase()] = [T];
    rpc.trusteesByTruster[T.toLowerCase()] = [A];
    // Group wrongly trusts C; we expect an untrust call for C
    rpc.trusteesByTruster[GROUP.toLowerCase()] = [
      C,
      ...Array.from(ALWAYS_TRUSTED_ADDRESSES),
    ];

    await runIncremental(deps, makeCfg(), state);

    expect(grp.calls.length).toBe(2);
    // First untrust C, then trust A
    expect(grp.calls[0].trusteeAddresses.map(x => x.toLowerCase())).toEqual([C.toLowerCase()]);
    expect(grp.calls[1].trusteeAddresses.map(x => x.toLowerCase())).toEqual([A.toLowerCase()]);
  });
});
