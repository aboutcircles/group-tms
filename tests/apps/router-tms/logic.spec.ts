import {getAddress} from "ethers";
import {
  runOnce,
  type Deps,
  type RunConfig,
  DEFAULT_BASE_GROUP_ADDRESS
} from "../../../src/apps/router-tms/logic";
import {
  FakeBlacklist,
  FakeCirclesRpc,
  FakeLogger,
  FakeRouterService,
  FakeRouterEnablementStore
} from "../../../fakes/fakes";

const ROUTER_ADDRESS = "0xDC287474114cC0551a81DdC2EB51783fBF34802F";

function makeDeps(overrides?: Partial<Deps>): Deps {
  const circlesRpc = overrides?.circlesRpc ?? new FakeCirclesRpc();
  if (circlesRpc instanceof FakeCirclesRpc) {
    circlesRpc.humanityOverrides.set(DEFAULT_BASE_GROUP_ADDRESS.toLowerCase(), false);
  }
  const blacklistingService = new FakeBlacklist();
  const logger = new FakeLogger(true);
  const enablementStore = new FakeRouterEnablementStore();

  return {
    circlesRpc,
    blacklistingService,
    logger,
    enablementStore,
    ...overrides
  };
}

function makeConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    rpcUrl: "https://rpc.example",
    routerAddress: ROUTER_ADDRESS,
    baseGroupAddress: DEFAULT_BASE_GROUP_ADDRESS,
    dryRun: true,
    enableBatchSize: 25,
    fetchPageSize: 50,
    ...overrides
  };
}

describe("router-tms runOnce", () => {
  it("throws when configured router address is invalid", async () => {
    const deps = makeDeps();
    const cfg = makeConfig({routerAddress: "not-an-address"});

    await expect(runOnce(deps, cfg)).rejects.toThrow("Invalid router address configured");
  });

  it("requires a router service when not running in dry-run mode", async () => {
    const deps = makeDeps();
    const cfg = makeConfig({dryRun: false});

    await expect(runOnce(deps, cfg)).rejects.toThrow("Router service dependency is required");
  });

  it("enables routing for every allowed non-blacklisted human avatar", async () => {
    const baseGroup = getAddress("0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026");
    const humanAlice = getAddress("0x2000000000000000000000000000000000000001");
    const humanBob = getAddress("0x2000000000000000000000000000000000000002");
    const humanCarol = getAddress("0x2000000000000000000000000000000000000003");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanAlice, humanBob, humanAlice, humanCarol];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [humanAlice];

    const blacklistingService = new FakeBlacklist(new Set([humanCarol.toLowerCase()]));
    const routerService = new FakeRouterService(["0xtx_enable"]);

    const deps = makeDeps({
      circlesRpc,
      blacklistingService,
      routerService
    });

    const cfg = makeConfig({
      dryRun: false,
      enableBatchSize: 2,
      fetchPageSize: 2,
      baseGroupAddress: baseGroup
    });

    const outcome = await runOnce(deps, cfg);

    expect(outcome.totalAvatarEntries).toBe(4);
    expect(outcome.uniqueHumanCount).toBe(3);
    expect(outcome.allowedHumanCount).toBe(2);
    expect(outcome.blacklistedHumanCount).toBe(1);
    expect(outcome.alreadyTrustedCount).toBe(1);
    expect(outcome.pendingEnableCount).toBe(1);
    expect(outcome.executedEnableCount).toBe(1);
    expect(outcome.txHashes).toEqual(["0xtx_enable"]);

    expect(routerService.calls).toEqual([
      {baseGroup: baseGroup.toLowerCase(), crcAddresses: [humanBob.toLowerCase()]}
    ]);
  });

  it("returns pending avatars but skips execution in dry-run mode", async () => {
    const humanAlice = getAddress("0x2000000000000000000000000000000000000010");
    const humanBob = getAddress("0x2000000000000000000000000000000000000011");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanAlice, humanBob];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [];

    const deps = makeDeps({circlesRpc});
    const cfg = makeConfig({dryRun: true});

    const outcome = await runOnce(deps, cfg);

    expect(outcome.pendingEnableCount).toBe(2);
    expect(outcome.executedEnableCount).toBe(0);
    expect(outcome.txHashes).toEqual([]);
  });

  it("skips avatars flagged as non-human by the hub before enabling routing", async () => {
    const humanAlice = getAddress("0x2000000000000000000000000000000000000500");
    const nonHuman = getAddress("0x2000000000000000000000000000000000000501");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanAlice, nonHuman];
    circlesRpc.humanityOverrides.set(nonHuman.toLowerCase(), false);

    const routerService = new FakeRouterService(["0xtx_human"]);

    const deps = makeDeps({
      circlesRpc,
      routerService
    });

    const cfg = makeConfig({
      dryRun: false,
      enableBatchSize: 2
    });

    const outcome = await runOnce(deps, cfg);

    expect(outcome.pendingEnableCount).toBe(1);
    expect(outcome.executedEnableCount).toBe(1);
    expect(outcome.txHashes).toEqual(["0xtx_human"]);

    expect(routerService.calls).toEqual([
      {baseGroup: DEFAULT_BASE_GROUP_ADDRESS.toLowerCase(), crcAddresses: [humanAlice.toLowerCase()]}
    ]);
  });

  it("enables routing per base group assignments and falls back to the configured Circles backer group", async () => {
    const circlesBackerGroup = getAddress("0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026");
    const baseGroupA = getAddress("0xA00000000000000000000000000000000000000A");
    const baseGroupB = getAddress("0xB00000000000000000000000000000000000000B");
    const humanAlice = getAddress("0x2000000000000000000000000000000000000100");
    const humanBob = getAddress("0x2000000000000000000000000000000000000101");
    const humanCarol = getAddress("0x2000000000000000000000000000000000000102");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanAlice, humanBob, humanCarol];
    circlesRpc.baseGroups = [baseGroupA, baseGroupB];
    circlesRpc.trusteesByTruster[baseGroupA.toLowerCase()] = [humanAlice];
    circlesRpc.trusteesByTruster[baseGroupB.toLowerCase()] = [humanBob];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [];

    const routerService = new FakeRouterService(["0xtx_a", "0xtx_b", "0xtx_c"]);

    const deps = makeDeps({
      circlesRpc,
      routerService
    });

    const cfg = makeConfig({
      dryRun: false,
      baseGroupAddress: circlesBackerGroup,
      enableBatchSize: 5
    });

    const outcome = await runOnce(deps, cfg);

    expect(outcome.pendingEnableCount).toBe(3);
    expect(outcome.executedEnableCount).toBe(3);
    expect(outcome.txHashes).toEqual(["0xtx_a", "0xtx_b", "0xtx_c"]);

    expect(routerService.calls).toEqual([
      {baseGroup: baseGroupA.toLowerCase(), crcAddresses: [humanAlice.toLowerCase()]},
      {baseGroup: baseGroupB.toLowerCase(), crcAddresses: [humanBob.toLowerCase()]},
      {baseGroup: circlesBackerGroup.toLowerCase(), crcAddresses: [humanCarol.toLowerCase()]}
    ]);
  });

  it("enables base group members that are missing from RegisterHuman before defaulting remaining humans", async () => {
    const baseGroup = getAddress("0xA0000000000000000000000000000000000000AA");
    const baseGroupMember = getAddress("0x2000000000000000000000000000000000000300");
    const humanBob = getAddress("0x2000000000000000000000000000000000000301");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanBob];
    circlesRpc.baseGroups = [baseGroup];
    circlesRpc.trusteesByTruster[baseGroup.toLowerCase()] = [baseGroupMember];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [];

    const routerService = new FakeRouterService(["0xtx_group", "0xtx_fallback"]);

    const deps = makeDeps({
      circlesRpc,
      routerService
    });

    const cfg = makeConfig({
      dryRun: false,
      enableBatchSize: 5
    });

    const outcome = await runOnce(deps, cfg);

    expect(outcome.allowedHumanCount).toBe(1);
    expect(outcome.blacklistedHumanCount).toBe(0);
    expect(outcome.pendingEnableCount).toBe(2);
    expect(outcome.executedEnableCount).toBe(2);
    expect(outcome.txHashes).toEqual(["0xtx_group", "0xtx_fallback"]);

    expect(routerService.calls).toEqual([
      {baseGroup: baseGroup.toLowerCase(), crcAddresses: [baseGroupMember.toLowerCase()]},
      {baseGroup: DEFAULT_BASE_GROUP_ADDRESS.toLowerCase(), crcAddresses: [humanBob.toLowerCase()]}
    ]);
  });

  it("skips enablement calls for avatars that were already processed in previous runs", async () => {
    const humanAlice = getAddress("0x2000000000000000000000000000000000000200");
    const humanBob = getAddress("0x2000000000000000000000000000000000000201");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanAlice, humanBob];

    const enablementStore = new FakeRouterEnablementStore();
    const routerService = new FakeRouterService(["0xtx_first"]);

    const deps = makeDeps({
      circlesRpc,
      routerService,
      enablementStore
    });

    const cfg = makeConfig({dryRun: false});

    await runOnce(deps, cfg);
    const secondOutcome = await runOnce(deps, cfg);

    expect(secondOutcome.pendingEnableCount).toBe(0);
    expect(secondOutcome.executedEnableCount).toBe(0);
    expect(secondOutcome.txHashes).toEqual([]);
    expect(routerService.calls).toHaveLength(1);
  });
});
