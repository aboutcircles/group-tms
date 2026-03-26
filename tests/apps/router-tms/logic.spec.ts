import {getAddress} from "ethers";
import {
  runOnce,
  type Deps,
  type RunConfig,
  DEFAULT_BASE_GROUP_ADDRESS,
  __testables
} from "../../../src/apps/router-tms/logic";
import {
  FakeBlacklist,
  FakeCirclesRpc,
  FakeLogger,
  FakeRouterService,
  FakeRouterEnablementStore
} from "../../../fakes/fakes";

const {
  buildAvatarBaseGroupAssignments,
  buildBaseGroupEnableTargets,
  chunkArray,
  createIsHumanChecker,
  filterHumanAvatars,
  normalizeAddress,
  normalizeAddressArray,
  validateEnableTargets
} = __testables;

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

  it("throws when configured base group address is invalid", async () => {
    const deps = makeDeps();
    const cfg = makeConfig({baseGroupAddress: "not-an-address"});

    await expect(runOnce(deps, cfg)).rejects.toThrow("Invalid base group address configured");
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
    const cfg = makeConfig({dryRun: true, enableBatchSize: 0, fetchPageSize: 0});

    const outcome = await runOnce(deps, cfg);

    expect(outcome.pendingEnableCount).toBe(2);
    expect(outcome.executedEnableCount).toBe(0);
    expect(outcome.txHashes).toEqual([]);
  });

  it("uses default config values when optional settings are omitted", async () => {
    const humanAlice = getAddress("0x2000000000000000000000000000000000000012");
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanAlice];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [];

    const outcome = await runOnce(
      makeDeps({circlesRpc}),
      makeConfig({
        dryRun: true,
        baseGroupAddress: undefined,
        enableBatchSize: undefined,
        fetchPageSize: undefined
      })
    );

    expect(outcome.pendingEnableCount).toBe(1);
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

  it("returns no pending enablement when every candidate is already trusted or blacklisted", async () => {
    const humanTrusted = getAddress("0x2000000000000000000000000000000000000700");
    const humanBlocked = getAddress("0x2000000000000000000000000000000000000701");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanTrusted, humanBlocked];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [humanTrusted];

    const deps = makeDeps({
      circlesRpc,
      blacklistingService: new FakeBlacklist(new Set(), new Set([humanBlocked.toLowerCase()]))
    });

    const outcome = await runOnce(deps, makeConfig({dryRun: true}));

    expect(outcome.pendingEnableCount).toBe(0);
    expect(outcome.executedEnableCount).toBe(0);
    expect(outcome.txHashes).toEqual([]);
  });

  it("treats missing blacklist verdicts as allowed", async () => {
    const humanAlice = getAddress("0x2000000000000000000000000000000000000800");
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [humanAlice];

    const blacklistingService = {
      loadBlacklist: async () => undefined,
      getBlacklistCount: () => 0,
      checkBlacklist: async () => []
    };

    const outcome = await runOnce(
      makeDeps({circlesRpc, blacklistingService: blacklistingService as any}),
      makeConfig({dryRun: true})
    );

    expect(outcome.allowedHumanCount).toBe(1);
    expect(outcome.blacklistedHumanCount).toBe(0);
    expect(outcome.pendingEnableCount).toBe(1);
  });

  it("throws when the configured default base group is classified as human", async () => {
    const circlesRpc = new FakeCirclesRpc();
    const deps = makeDeps({circlesRpc});
    circlesRpc.humanityOverrides.set(DEFAULT_BASE_GROUP_ADDRESS.toLowerCase(), true);

    await expect(runOnce(deps, makeConfig({dryRun: true}))).rejects.toThrow(
      "Base group"
    );
  });

  it("skips non-default base groups classified as humans and still processes fallback targets", async () => {
    const baseGroup = getAddress("0xA0000000000000000000000000000000000000BB");
    const assignedAvatar = getAddress("0x2000000000000000000000000000000000000900");
    const fallbackAvatar = getAddress("0x2000000000000000000000000000000000000901");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [assignedAvatar, fallbackAvatar];
    circlesRpc.baseGroups = [baseGroup];
    circlesRpc.trusteesByTruster[baseGroup.toLowerCase()] = [assignedAvatar];
    circlesRpc.humanityOverrides.set(baseGroup.toLowerCase(), true);

    const outcome = await runOnce(makeDeps({circlesRpc}), makeConfig({dryRun: true}));

    expect(outcome.pendingEnableCount).toBe(1);
  });

  it("throws when a fallback target contains an invalid avatar address", async () => {
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = ["not-an-address"];

    await expect(runOnce(makeDeps({circlesRpc}), makeConfig({dryRun: true}))).rejects.toThrow(
      "Invalid address passed to isHuman check"
    );
  });
});

describe("router-tms helpers", () => {
  it("normalizes addresses and removes invalid or duplicate values", () => {
    const first = getAddress("0x2000000000000000000000000000000000000A00");
    const second = getAddress("0x2000000000000000000000000000000000000A01");

    expect(normalizeAddress(null as any)).toBeUndefined();
    expect(normalizeAddress("bad-address")).toBeUndefined();
    expect(normalizeAddressArray([first, first.toLowerCase(), "bad-address", second])).toEqual([
      first.toLowerCase(),
      second.toLowerCase()
    ]);
  });

  it("chunks values and keeps zero-sized chunks as a single batch", () => {
    expect(chunkArray([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunkArray([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });

  it("caches humanity lookups and clears the cache on failures", async () => {
    const circlesRpc = new FakeCirclesRpc();
    const human = getAddress("0x2000000000000000000000000000000000000B00");
    const flaky = getAddress("0x2000000000000000000000000000000000000B01");
    class FlakyCirclesRpc extends FakeCirclesRpc {
      override async isHuman(address: string): Promise<boolean> {
        if (address === flaky.toLowerCase()) {
          throw new Error("temporary");
        }
        return super.isHuman(address);
      }
    }

    const checker = createIsHumanChecker(Object.assign(new FlakyCirclesRpc(), circlesRpc));

    await expect(checker("bad-address")).rejects.toThrow("Invalid address passed to isHuman check");
    await expect(checker(flaky)).rejects.toThrow("temporary");
    await expect(checker(flaky)).rejects.toThrow("temporary");

    expect(await checker(human)).toBe(true);
    expect(await checker(human)).toBe(true);
  });

  it("filters human avatars and groups eligible base group assignments", async () => {
    const humanA = getAddress("0x2000000000000000000000000000000000000C00");
    const humanB = getAddress("0x2000000000000000000000000000000000000C01");
    const baseGroup = getAddress("0xA0000000000000000000000000000000000000CC");
    const result = await filterHumanAvatars(
      [humanA, humanB],
      async (address) => address === humanA,
      1
    );

    expect(result).toEqual({humans: [humanA], nonHumans: [humanB]});

    const grouped = buildBaseGroupEnableTargets(
      new Map([
        [humanA, baseGroup.toLowerCase()],
        [humanB, baseGroup.toLowerCase()],
        [getAddress("0x2000000000000000000000000000000000000C02"), baseGroup.toLowerCase()]
      ]),
      new Set([humanA, humanB, getAddress("0x2000000000000000000000000000000000000C02")]),
      new Set([humanB]),
      (avatar) => avatar !== getAddress("0x2000000000000000000000000000000000000C02")
    );

    expect(grouped.targets).toEqual([
      {baseGroup: baseGroup.toLowerCase(), addresses: [humanA], source: "base-group"}
    ]);
    expect(grouped.scheduledAvatars).toEqual(new Set([humanA]));
  });

  it("creates grouped enable targets for eligible avatars", () => {
    const baseGroup = getAddress("0xA0000000000000000000000000000000000000DE").toLowerCase();
    const avatarA = getAddress("0x2000000000000000000000000000000000000F00").toLowerCase();
    const avatarB = getAddress("0x2000000000000000000000000000000000000F01").toLowerCase();

    const grouped = buildBaseGroupEnableTargets(
      new Map([
        [avatarA, baseGroup],
        [avatarB, baseGroup]
      ]),
      new Set([avatarA, avatarB]),
      new Set(),
      () => true
    );

    expect(grouped.targets).toEqual([
      {baseGroup, addresses: [avatarA, avatarB], source: "base-group"}
    ]);
  });

  it("preserves the first base-group assignment for duplicate trustees", async () => {
    const logger = new FakeLogger(true);
    const baseGroupA = getAddress("0xA0000000000000000000000000000000000000EA");
    const baseGroupB = getAddress("0xB0000000000000000000000000000000000000EB");
    const trustee = getAddress("0x2000000000000000000000000000000000000E00");
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.baseGroups = [baseGroupA, baseGroupB];
    circlesRpc.trusteesByTruster[baseGroupA.toLowerCase()] = [trustee];
    circlesRpc.trusteesByTruster[baseGroupB.toLowerCase()] = [trustee];

    const assignments = await buildAvatarBaseGroupAssignments(circlesRpc, logger);
    expect(assignments.get(trustee.toLowerCase())).toBe(baseGroupA.toLowerCase());
  });

  it("validates base groups and skips targets with no humans left", async () => {
    const logger = new FakeLogger(true);
    const defaultBaseGroup = DEFAULT_BASE_GROUP_ADDRESS.toLowerCase();
    const otherBaseGroup = getAddress("0xA0000000000000000000000000000000000000DD").toLowerCase();
    const human = getAddress("0x2000000000000000000000000000000000000D00").toLowerCase();

    await expect(validateEnableTargets(
      [{baseGroup: defaultBaseGroup, addresses: [human], source: "fallback"}],
      async (address) => address === defaultBaseGroup,
      defaultBaseGroup,
      logger
    )).rejects.toThrow("Base group");

    const filtered = await validateEnableTargets(
      [{baseGroup: otherBaseGroup, addresses: [human], source: "base-group"}],
      async (address) => address !== otherBaseGroup && false,
      defaultBaseGroup,
      logger
    );

    expect(filtered.validTargets).toEqual([]);
    expect(filtered.nonHumanAvatars).toEqual(new Set([human]));
  });
});
