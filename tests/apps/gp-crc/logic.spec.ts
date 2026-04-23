import {getAddress} from "ethers";
import {runOnce, type Deps, type RunConfig, __testables} from "../../../src/apps/gp-crc/logic";
import {
  FakeAvatarSafeService,
  FakeAvatarSafeMappingStore,
  FakeBlacklist,
  FakeCirclesRpc,
  FakeGroupService,
  FakeLogger
} from "../../../fakes/fakes";

const {
  compareTimestamp,
  formatErrorMessage,
  isBlacklisted,
  isRetryableFetchError,
  isRetryableTrustError,
  normalizeAddress,
  normalizeSwitchCount,
  toComparableBigInt,
  uniqueNormalizedAddresses
} = __testables;

const RPC_URL = "https://rpc.stub";
const GROUP_ADDRESS = "0x1000000000000000000000000000000000000000";

function makeDeps(overrides?: Partial<Deps>): Deps {
  const blacklistingService = new FakeBlacklist();
  const logger = new FakeLogger(true);
  const groupService = new FakeGroupService();
  const avatarSafeService = new FakeAvatarSafeService();
  const circlesRpc = new FakeCirclesRpc();

  return {
    blacklistingService,
    avatarSafeService,
    circlesRpc,
    groupService,
    logger,
    ...overrides
  };
}

function makeConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    rpcUrl: RPC_URL,
    fetchPageSize: 1_000,
    groupAddress: GROUP_ADDRESS,
    dryRun: false,
    groupBatchSize: 10,
    ...overrides
  };
}

describe("gp-crc runOnce (query-based)", () => {
  it("throws when configured group address is invalid", async () => {
    const deps = makeDeps();
    const cfg = makeConfig({groupAddress: "not-an-address"});

    await expect(runOnce(deps, cfg)).rejects.toThrow("Invalid group address configured");
  });

  it("requires group service when not running in dry-run mode", async () => {
    const deps = makeDeps({groupService: undefined});
    const cfg = makeConfig();

    await expect(runOnce(deps, cfg)).rejects.toThrow("Group service dependency is required");
  });

  it("trusts allowed avatars with safes and skips blacklisted ones", async () => {
    const allowedInput = "0xaaaa000000000000000000000000000000000000";
    const blockedInput = "0xbbbb000000000000000000000000000000000000";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [allowedInput, blockedInput, allowedInput];

    const blacklistingService = new FakeBlacklist(new Set([blockedInput]));
    const avatarSafeService = new FakeAvatarSafeService({[allowedInput]: "0xsafe1"});
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, blacklistingService, avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const allowed = getAddress(allowedInput);
    const blocked = getAddress(blockedInput);

    expect(outcome.allowedAvatars).toEqual([allowed]);
    expect(outcome.blacklistedAvatars).toEqual([blocked]);
    expect(outcome.trustedAvatars).toEqual([allowed]);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("skips avatars that are already trusted in the group", async () => {
    const alreadyTrusted = "0x1111000000000000000000000000000000000000";
    const newcomer = "0x2222000000000000000000000000000000000000";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [alreadyTrusted, newcomer];
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [alreadyTrusted];

    const avatarSafeService = new FakeAvatarSafeService({
      [alreadyTrusted]: "0xsafeA",
      [newcomer]: "0xsafeB"
    });
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(outcome.trustedAvatars).toEqual([getAddress(newcomer)]);
    expect(groupService.calls).toHaveLength(1);
    expect(groupService.calls[0]).toEqual({
      type: "trust",
      groupAddress: cfg.groupAddress,
      trusteeAddresses: [getAddress(newcomer)]
    });
  });

  it("skips allowed avatars without configured safes", async () => {
    const withSafe = "0x1111000000000000000000000000000000000000";
    const withoutSafe = "0x2222000000000000000000000000000000000000";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [withSafe, withoutSafe];

    const avatarSafeService = new FakeAvatarSafeService({
      [withSafe]: "0xsafe1111"
    });
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(outcome.trustedAvatars).toEqual([getAddress(withSafe)]);
    expect(groupService.calls).toHaveLength(1);
    expect(groupService.calls[0].trusteeAddresses).toEqual([getAddress(withSafe)]);
  });

  it("supports dry-run mode by skipping on-chain trust calls", async () => {
    const avatarInput = "0xcccc000000000000000000000000000000000000";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];

    const groupService = new FakeGroupService();
    const deps = makeDeps({circlesRpc, groupService});
    const cfg = makeConfig({dryRun: true});

    const outcome = await runOnce(deps, cfg);

    const avatar = getAddress(avatarInput);
    expect(outcome.trustedAvatars).toEqual([avatar]);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(groupService.calls).toHaveLength(0);
  });

  it("retries trust batches on retryable errors before succeeding", async () => {
    const avatarInput = "0xdddd000000000000000000000000000000000000";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];

    class FlakyGroupService extends FakeGroupService {
      attempts = 0;
      override async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
        this.attempts += 1;
        if (this.attempts === 1) {
          const error = new Error("temporary");
          (error as any).code = "NETWORK_ERROR";
          throw error;
        }
        return super.trustBatchWithConditions(groupAddress, trusteeAddresses);
      }
    }

    const groupService = new FlakyGroupService();
    const deps = makeDeps({circlesRpc, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(groupService.attempts).toBe(2);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
  });

  it("retries blacklist checks on retryable errors", async () => {
    const avatarInput = "0xffff111100000000000000000000000000000000";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];

    class FlakyBlacklistService extends FakeBlacklist {
      attempts = 0;
      override async checkBlacklist(addresses: string[]) {
        this.attempts += 1;
        if (this.attempts === 1) {
          const error = new Error("temporary");
          (error as any).code = "NETWORK_ERROR";
          throw error;
        }
        return super.checkBlacklist(addresses);
      }
    }

    const blacklistingService = new FlakyBlacklistService();
    const deps = makeDeps({circlesRpc, blacklistingService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(blacklistingService.attempts).toBe(2);
    expect(outcome.trustedAvatars).toEqual([getAddress(avatarInput)]);
  });

  it("untrusts avatars that become blacklisted", async () => {
    const avatarInput = "0x4444000000000000000000000000000000000000";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = []; // No new humans; trust list only
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarInput];

    const blacklistingService = new FakeBlacklist(new Set([avatarInput]));
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, blacklistingService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const avatar = getAddress(avatarInput);
    expect(outcome.untrustedAvatars).toEqual([avatar]);
    expect(outcome.untrustTxHashes).toEqual(["0xuntrust_1"]);
  });

  it("untrusts avatars that no longer have an associated safe", async () => {
    const avatarInput = "0x5555000000000000000000000000000000000000";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [];
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarInput];

    const avatarSafeService = new FakeAvatarSafeService({}); // no safes
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const avatar = getAddress(avatarInput);
    expect(outcome.untrustedAvatars).toEqual([avatar]);
    expect(outcome.untrustTxHashes).toEqual(["0xuntrust_1"]);
  });

  it("picks the owner with the latest timestamp for a shared safe", async () => {
    const avatarA = "0x1111000000000000000000000000000000000000";
    const avatarB = "0x2222000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000001";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarA, avatarB];

    const avatarSafeService = new FakeAvatarSafeService({
      [avatarA]: {safe: sharedSafe, timestamp: 100},
      [avatarB]: {safe: sharedSafe, timestamp: 200}
    });

    const groupService = new FakeGroupService();
    const deps = makeDeps({circlesRpc, avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const normalB = getAddress(avatarB);
    const normalA = getAddress(avatarA);

    expect(outcome.trustedAvatars).toEqual([normalB]);
    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.trustedAvatars).not.toContain(normalA);
  });

  it("switches to a newer timestamp owner while switch count is below the cap", async () => {
    const oldAvatarInput = "0x1111000000000000000000000000000000000000";
    const newAvatarInput = "0x2222000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000001";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [newAvatarInput];
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [oldAvatarInput];

    const avatarSafeService = new FakeAvatarSafeService({
      [oldAvatarInput]: {safe: sharedSafe, timestamp: 100},
      [newAvatarInput]: {safe: sharedSafe, timestamp: 200}
    });
    const oldAvatar = getAddress(oldAvatarInput);
    const newAvatar = getAddress(newAvatarInput);
    const mappingStore = new FakeAvatarSafeMappingStore(
      {[oldAvatarInput]: sharedSafe},
      {
        [sharedSafe]: {
          trustedAvatar: oldAvatar,
          trustedTimestamp: "100",
          switchCount: 0
        }
      }
    );
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([oldAvatar]);
    expect(outcome.untrustedAvatars).toContain(oldAvatar);
    expect(outcome.trustedAvatars).toContain(newAvatar);

    const saved = mappingStore.getSavedMapping();
    expect(saved.get(newAvatar)).toBe(sharedSafe);
    expect(saved.has(oldAvatar)).toBe(false);

    const safeState = mappingStore.getSavedSafeTrustState().get(sharedSafe);
    expect(safeState).toEqual({
      trustedAvatar: newAvatar,
      trustedTimestamp: "200",
      switchCount: 1
    });
  });

  it("keeps the existing trusted owner when candidate timestamp is not newer", async () => {
    const oldAvatarInput = "0x1111000000000000000000000000000000000000";
    const candidateAvatarInput = "0x2222000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000001";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [candidateAvatarInput];
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [oldAvatarInput];

    const avatarSafeService = new FakeAvatarSafeService({
      [candidateAvatarInput]: {safe: sharedSafe, timestamp: 250}
    });
    const oldAvatar = getAddress(oldAvatarInput);
    const mappingStore = new FakeAvatarSafeMappingStore(
      {[oldAvatarInput]: sharedSafe},
      {
        [sharedSafe]: {
          trustedAvatar: oldAvatar,
          trustedTimestamp: "300",
          switchCount: 1
        }
      }
    );
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.trustedAvatars).toEqual([]);
    expect(mappingStore.getSavedMapping().get(oldAvatar)).toBe(sharedSafe);
  });

  it("keeps the existing trusted owner after two switches even when a newer timestamp appears", async () => {
    const oldAvatarInput = "0x1111000000000000000000000000000000000000";
    const candidateAvatarInput = "0x2222000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000001";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [candidateAvatarInput];
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [oldAvatarInput];

    const avatarSafeService = new FakeAvatarSafeService({
      [candidateAvatarInput]: {safe: sharedSafe, timestamp: 500}
    });
    const oldAvatar = getAddress(oldAvatarInput);
    const mappingStore = new FakeAvatarSafeMappingStore(
      {[oldAvatarInput]: sharedSafe},
      {
        [sharedSafe]: {
          trustedAvatar: oldAvatar,
          trustedTimestamp: "300",
          switchCount: 2
        }
      }
    );
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.trustedAvatars).toEqual([]);
    expect(mappingStore.getSavedMapping().get(oldAvatar)).toBe(sharedSafe);

    const safeState = mappingStore.getSavedSafeTrustState().get(sharedSafe);
    expect(safeState).toEqual({
      trustedAvatar: oldAvatar,
      trustedTimestamp: "300",
      switchCount: 2
    });
  });

  it("returns early when neither human avatars nor trustees produce evaluation candidates", async () => {
    const circlesRpc = new FakeCirclesRpc();
    const outcome = await runOnce(makeDeps({circlesRpc}), makeConfig({dryRun: true, fetchPageSize: 0, groupBatchSize: 0}));

    expect(outcome.uniqueAvatarCount).toBe(0);
    expect(outcome.allowedAvatars).toEqual([]);
    expect(outcome.trustedAvatars).toEqual([]);
  });

  it("uses default fetch and batch sizes when config leaves them undefined", async () => {
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = ["0x6767000000000000000000000000000000000000"];

    const outcome = await runOnce(
      makeDeps({circlesRpc}),
      makeConfig({dryRun: true, fetchPageSize: undefined, groupBatchSize: undefined})
    );

    expect(outcome.uniqueAvatarCount).toBe(1);
  });

  it("ignores invalid trustee addresses returned from the group service", async () => {
    const validAvatar = "0x6666000000000000000000000000000000000000";
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [validAvatar];
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = ["bad-address"];

    const outcome = await runOnce(makeDeps({circlesRpc}), makeConfig({dryRun: true}));

    expect(outcome.allowedAvatars).toEqual([getAddress(validAvatar)]);
  });

  it("updates safe state when the same avatar remains selected for a safe", async () => {
    const avatarInput = "0x7777000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000777";
    const avatar = getAddress(avatarInput);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];
    const avatarSafeService = new FakeAvatarSafeService({
      [avatarInput]: {safe: sharedSafe, timestamp: "2025-03-01T00:00:00.000Z"}
    });
    const mappingStore = new FakeAvatarSafeMappingStore(
      {[avatarInput]: sharedSafe},
      {
        [sharedSafe]: {
          trustedAvatar: avatar,
          trustedTimestamp: "2025-02-01T00:00:00.000Z",
          switchCount: Number.NaN
        }
      }
    );

    await runOnce(
      makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore}),
      makeConfig({dryRun: true})
    );

    expect(mappingStore.getSavedSafeTrustState().get(sharedSafe)).toEqual({
      trustedAvatar: avatar,
      trustedTimestamp: "2025-03-01T00:00:00.000Z",
      switchCount: 0
    });
  });

  it("keeps the previous trusted timestamp when the same avatar is selected with an older timestamp", async () => {
    const avatarInput = "0x7878000000000000000000000000000000000001";
    const sharedSafe = "0xSAFE000000000000000000000000000000000781";
    const avatar = getAddress(avatarInput);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];
    const avatarSafeService = new FakeAvatarSafeService({
      [avatarInput]: {safe: sharedSafe, timestamp: "100"}
    });
    const mappingStore = new FakeAvatarSafeMappingStore(
      {[avatarInput]: sharedSafe},
      {
        [sharedSafe]: {
          trustedAvatar: avatar,
          trustedTimestamp: "200",
          switchCount: 1
        }
      }
    );

    await runOnce(
      makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore}),
      makeConfig({dryRun: true})
    );

    expect(mappingStore.getSavedSafeTrustState().get(sharedSafe)).toEqual({
      trustedAvatar: avatar,
      trustedTimestamp: "200",
      switchCount: 1
    });
  });

  it("preserves the existing switch count when the same avatar stays trusted without a prior timestamp", async () => {
    const avatarInput = "0x7979000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000779";
    const avatar = getAddress(avatarInput);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];
    const avatarSafeService = new FakeAvatarSafeService({
      [avatarInput]: {safe: sharedSafe, timestamp: "250"}
    });
    const mappingStore = new FakeAvatarSafeMappingStore(
      {[avatarInput]: sharedSafe},
      {
        [sharedSafe]: {
          trustedAvatar: avatar,
          trustedTimestamp: "" as any,
          switchCount: 1
        }
      }
    );

    await runOnce(
      makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore}),
      makeConfig({dryRun: true})
    );

    expect(mappingStore.getSavedSafeTrustState().get(sharedSafe)).toEqual({
      trustedAvatar: avatar,
      trustedTimestamp: "250",
      switchCount: 1
    });
  });

  it("keeps the selected avatar and timestamp when a stored mapping exists without prior safe state", async () => {
    const avatarInput = "0x7878000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000778";
    const avatar = getAddress(avatarInput);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];
    const avatarSafeService = new FakeAvatarSafeService({
      [avatarInput]: {safe: sharedSafe, timestamp: "200"}
    });
    const mappingStore = new FakeAvatarSafeMappingStore({[avatarInput]: sharedSafe});

    await runOnce(
      makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore}),
      makeConfig({dryRun: true})
    );

    expect(mappingStore.getSavedSafeTrustState().get(sharedSafe)).toEqual({
      trustedAvatar: avatar,
      trustedTimestamp: "200",
      switchCount: 0
    });
  });

  it("keeps the mapped owner when there is no prior safe trust timestamp to compare against", async () => {
    const oldAvatarInput = "0x7A7A000000000000000000000000000000000000";
    const newAvatarInput = "0x7B7B000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE00000000000000000000000000000000077A";
    const oldAvatar = getAddress(oldAvatarInput);
    const newAvatar = getAddress(newAvatarInput);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [newAvatarInput];
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [oldAvatarInput];
    const avatarSafeService = new FakeAvatarSafeService({
      [newAvatarInput]: {safe: sharedSafe, timestamp: "300"}
    });
    const mappingStore = new FakeAvatarSafeMappingStore({[oldAvatarInput]: sharedSafe});

    const outcome = await runOnce(
      makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore}),
      makeConfig({dryRun: true})
    );

    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([]);
    expect(mappingStore.getSavedSafeTrustState().get(sharedSafe)).toEqual({
      trustedAvatar: oldAvatar,
      trustedTimestamp: "300",
      switchCount: 0
    });
  });

  it("treats missing blacklist verdicts as allowed", async () => {
    const avatarInput = "0x8888000000000000000000000000000000000000";
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];

    const blacklistingService = {
      loadBlacklist: async () => undefined,
      getBlacklistCount: () => 0,
      checkBlacklist: async () => []
    };

    const outcome = await runOnce(
      makeDeps({circlesRpc, blacklistingService: blacklistingService as any}),
      makeConfig({dryRun: true})
    );

    expect(outcome.allowedAvatars).toEqual([getAddress(avatarInput)]);
  });

  it("persists a first-time safe owner when no previous mapping exists", async () => {
    const avatarInput = "0x8989000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000898";
    const avatar = getAddress(avatarInput);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];
    const avatarSafeService = new FakeAvatarSafeService({
      [avatarInput]: {safe: sharedSafe, timestamp: "123"}
    });
    const mappingStore = new FakeAvatarSafeMappingStore();

    await runOnce(
      makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore}),
      makeConfig({dryRun: true})
    );

    expect(mappingStore.getSavedSafeTrustState().get(sharedSafe)).toEqual({
      trustedAvatar: avatar,
      trustedTimestamp: "123",
      switchCount: 0
    });
  });

  it("logs dry-run untrust batches when trusted avatars are no longer eligible", async () => {
    const avatarInput = "0xA0A0000000000000000000000000000000000000";
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarInput];
    const groupService = new FakeGroupService();

    const outcome = await runOnce(
      makeDeps({
        circlesRpc,
        avatarSafeService: new FakeAvatarSafeService({}),
        groupService
      }),
      makeConfig({dryRun: true})
    );

    expect(outcome.untrustedAvatars).toEqual([getAddress(avatarInput)]);
    expect(groupService.calls).toHaveLength(0);
  });

  it("surfaces non-retryable trust failures immediately", async () => {
    const avatarInput = "0x9999000000000000000000000000000000000000";
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];

    class FatalTrustGroupService extends FakeGroupService {
      override async trustBatchWithConditions(): Promise<string> {
        const error = new Error("insufficient funds");
        (error as any).code = "INSUFFICIENT_FUNDS";
        throw error;
      }
    }

    await expect(
      runOnce(
        makeDeps({circlesRpc, groupService: new FatalTrustGroupService()}),
        makeConfig()
      )
    ).rejects.toThrow("insufficient funds");
  });

  it("wraps string trust failures in an Error", async () => {
    const avatarInput = "0x9A9A000000000000000000000000000000000000";
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [avatarInput];

    class StringTrustGroupService extends FakeGroupService {
      override async trustBatchWithConditions(): Promise<string> {
        throw "boom";
      }
    }

    await expect(
      runOnce(
        makeDeps({circlesRpc, groupService: new StringTrustGroupService()}),
        makeConfig()
      )
    ).rejects.toThrow("boom");
  });

  it("surfaces non-retryable untrust failures immediately", async () => {
    const avatarInput = "0xAAAA000000000000000000000000000000000000";
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarInput];

    class FatalUntrustGroupService extends FakeGroupService {
      override async untrustBatch(): Promise<string> {
        const error = new Error("fatal");
        (error as any).code = "CALL_EXCEPTION";
        throw error;
      }
    }

    await expect(
      runOnce(
        makeDeps({
          circlesRpc,
          avatarSafeService: new FakeAvatarSafeService({}),
          groupService: new FatalUntrustGroupService()
        }),
        makeConfig()
      )
    ).rejects.toThrow("fatal");
  });

  it("wraps string untrust failures in an Error", async () => {
    const avatarInput = "0xABAB000000000000000000000000000000000000";
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarInput];

    class StringUntrustGroupService extends FakeGroupService {
      override async untrustBatch(): Promise<string> {
        throw "boom";
      }
    }

    await expect(
      runOnce(
        makeDeps({
          circlesRpc,
          avatarSafeService: new FakeAvatarSafeService({}),
          groupService: new StringUntrustGroupService()
        }),
        makeConfig()
      )
    ).rejects.toThrow("boom");
  });

  it("surfaces non-retryable blacklist failures", async () => {
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = ["0xBBBB000000000000000000000000000000000000"];

    const blacklistingService = {
      loadBlacklist: async () => undefined,
      getBlacklistCount: () => 0,
      checkBlacklist: async () => {
        throw new Error("permanent");
      }
    };

    await expect(
      runOnce(
        makeDeps({circlesRpc, blacklistingService: blacklistingService as any}),
        makeConfig({dryRun: true})
      )
    ).rejects.toThrow("permanent");
  });

  it("wraps string blacklist failures in an Error", async () => {
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = ["0xBCBC000000000000000000000000000000000000"];

    const blacklistingService = {
      loadBlacklist: async () => undefined,
      getBlacklistCount: () => 0,
      checkBlacklist: async () => {
        throw "boom";
      }
    };

    await expect(
      runOnce(
        makeDeps({circlesRpc, blacklistingService: blacklistingService as any}),
        makeConfig({dryRun: true})
      )
    ).rejects.toThrow("boom");
  });

  it("retries untrust batches on retryable errors before succeeding", async () => {
    const avatarInput = "0xACAC000000000000000000000000000000000000";
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarInput];

    class FlakyUntrustGroupService extends FakeGroupService {
      attempts = 0;
      override async untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
        this.attempts += 1;
        if (this.attempts === 1) {
          const error = new Error("temporary network issue");
          (error as any).code = "NETWORK_ERROR";
          throw error;
        }
        return super.untrustBatch(groupAddress, trusteeAddresses);
      }
    }

    const groupService = new FlakyUntrustGroupService();
    const outcome = await runOnce(
      makeDeps({
        circlesRpc,
        avatarSafeService: new FakeAvatarSafeService({}),
        groupService
      }),
      makeConfig()
    );

    expect(groupService.attempts).toBe(2);
    expect(outcome.untrustTxHashes).toEqual(["0xuntrust_1"]);
  });
});

describe("gp-crc helpers", () => {
  it("normalizes, deduplicates, and skips invalid addresses", () => {
    const first = getAddress("0x1000000000000000000000000000000000000100");
    const second = getAddress("0x1000000000000000000000000000000000000101");

    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("not-an-address")).toBeNull();
    expect(uniqueNormalizedAddresses([first, first.toLowerCase(), "bad-address", second])).toEqual([
      first,
      second
    ]);
  });

  it("classifies retryable fetch errors", () => {
    expect(isRetryableFetchError("temporary")).toBe(true);
    expect(isRetryableFetchError({name: "AbortError"})).toBe(true);
    expect(isRetryableFetchError({code: "NETWORK_ERROR"})).toBe(true);
    expect(isRetryableFetchError({message: "network timeout"})).toBe(true);
    expect(isRetryableFetchError({message: "fatal"})).toBe(false);
  });

  it("classifies retryable trust errors", () => {
    expect(isRetryableTrustError("temporary")).toBe(true);
    expect(isRetryableTrustError({code: "NETWORK_ERROR"})).toBe(true);
    expect(isRetryableTrustError({message: "temporary network timeout"})).toBe(true);
    expect(isRetryableTrustError({message: "nonce too low"})).toBe(false);
    expect(isRetryableTrustError({code: "CALL_EXCEPTION"})).toBe(false);
    expect(isRetryableTrustError({message: "fatal"})).toBe(false);
  });

  it("formats errors and compares timestamps across numeric, date, and string values", () => {
    const circular: any = {};
    circular.self = circular;

    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
    expect(formatErrorMessage("plain")).toBe("plain");
    expect(formatErrorMessage(circular)).toBe("[object Object]");

    expect(normalizeSwitchCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeSwitchCount(2.9)).toBe(2);

    expect(compareTimestamp("10", "10")).toBe(0);
    expect(compareTimestamp("11", "10")).toBe(1);
    expect(compareTimestamp("2025-03-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z")).toBe(1);
    expect(compareTimestamp("beta", "alpha")).toBe(1);

    expect(toComparableBigInt("42")).toBe(42n);
    expect(toComparableBigInt("2025-03-01T00:00:00.000Z")).not.toBeNull();
    expect(toComparableBigInt("not-a-date")).toBeNull();
  });

  it("classifies blacklist verdicts consistently", () => {
    expect(isBlacklisted({address: "0x1", is_bot: true} as any)).toBe(true);
    expect(isBlacklisted({address: "0x1", is_bot: false, category: "flagged"} as any)).toBe(true);
    expect(isBlacklisted({address: "0x1", is_bot: false} as any)).toBe(false);
  });
});
