import {getAddress} from "ethers";
import {runOnce, type Deps, type RunConfig} from "../../../src/apps/gnosis-group/logic";
import {FakeBlacklist, FakeCirclesRpc, FakeGroupService, FakeLogger} from "../../../fakes/fakes";
import {IGroupService} from "../../../src/interfaces/IGroupService";

class FlakyGroupService implements IGroupService {
  calls: { type: "trust" | "untrust"; groupAddress: string; trusteeAddresses: string[] }[] = [];
  trustAttempts = 0;
  untrustAttempts = 0;
  successfulTrustBatches = 0;
  successfulUntrustBatches = 0;
  private readonly trustFailures = new Map<string, number>();
  private readonly untrustFailures = new Map<string, number>();

  setTrustFailure(groupAddress: string, trusteeAddresses: string[], failures: number): void {
    this.trustFailures.set(this.makeKey(groupAddress, trusteeAddresses), failures);
  }

  setUntrustFailure(groupAddress: string, trusteeAddresses: string[], failures: number): void {
    this.untrustFailures.set(this.makeKey(groupAddress, trusteeAddresses), failures);
  }

  async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    this.trustAttempts += 1;
    const key = this.makeKey(groupAddress, trusteeAddresses);
    const remaining = this.trustFailures.get(key) ?? 0;
    if (remaining > 0) {
      this.trustFailures.set(key, remaining - 1);
      throw new Error("Simulated trust failure");
    }

    this.successfulTrustBatches += 1;
    this.calls.push({type: "trust", groupAddress, trusteeAddresses: [...trusteeAddresses]});
    return `0xflaky_trust_${this.successfulTrustBatches}`;
  }

  async untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    this.untrustAttempts += 1;
    const key = this.makeKey(groupAddress, trusteeAddresses);
    const remaining = this.untrustFailures.get(key) ?? 0;
    if (remaining > 0) {
      this.untrustFailures.set(key, remaining - 1);
      throw new Error("Simulated untrust failure");
    }

    this.successfulUntrustBatches += 1;
    this.calls.push({type: "untrust", groupAddress, trusteeAddresses: [...trusteeAddresses]});
    return `0xflaky_untrust_${this.successfulUntrustBatches}`;
  }

  async fetchGroupOwnerAndService(): Promise<any> {
    throw new Error("Not used in tests");
  }

  private makeKey(groupAddress: string, trusteeAddresses: string[]): string {
    const normalizedAddresses = trusteeAddresses.map((addr) => addr.toLowerCase()).sort().join(",");
    return `${groupAddress.toLowerCase()}|${normalizedAddresses}`;
  }
}

describe("gnosis-group runOnce", () => {
  const circlesBackerGroup = getAddress("0x1000000000000000000000000000000000000001");
  const targetGroup = getAddress("0x2000000000000000000000000000000000000002");
  const trustedTarget = getAddress("0x3000000000000000000000000000000000000003");
  const customAutoTrustGroup = getAddress("0x4000000000000000000000000000000000000004");

  it("fetches relative trust scores when running in dry-run mode", async () => {
    const highScoreRaw = "0x4000000000000000000000000000000000000004";
    const lowScoreRaw = "0x5000000000000000000000000000000000000005";
    const highScoreAddress = getAddress(highScoreRaw);
    const lowScoreAddress = getAddress(lowScoreRaw);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [highScoreAddress, lowScoreAddress];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [];

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true)
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: true,
      scoreThreshold: 50,
      scoreBatchSize: 10,
      groupBatchSize: 10
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [
            {address: highScoreAddress, relative_score: 75},
            {address: lowScoreAddress, relative_score: 10}
          ]
        }
      })
    });

    jest.useFakeTimers();
    const runPromise = runOnce(deps, cfg);
    await jest.runOnlyPendingTimersAsync();
    const outcome = await runPromise;
    jest.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.scores[highScoreAddress]).toBe(75);
    expect(outcome.scores[lowScoreAddress]).toBe(10);
    expect(outcome.addressesAboveThresholdToTrust).toContain(highScoreAddress);
    expect(outcome.trustTxHashes).toHaveLength(0);
    expect(outcome.addressesToUntrust).toEqual([]);
    expect(outcome.untrustBatches).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
    const [fetchUrl, fetchInit] = fetchMock.mock.calls[0] ?? [];
    expect(fetchUrl).toBe("https://scores.local");
    const requestBody = JSON.parse((fetchInit?.body ?? "{}") as string);
    expect(requestBody.target_sets).toEqual([[trustedTarget]]);
  });

  it("uses env-defined score threshold when config omits the value", async () => {
    const previousEnvThreshold = process.env.GNOSIS_GROUP_SCORE_THRESHOLD;
    process.env.GNOSIS_GROUP_SCORE_THRESHOLD = "42";

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [trustedTarget];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [];

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true)
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: true,
      scoreBatchSize: 5,
      groupBatchSize: 5
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [{address: trustedTarget, relative_score: 50}]
        }
      })
    });

    try {
      jest.useFakeTimers();
      let outcome: Awaited<ReturnType<typeof runOnce>>;
      try {
        const runPromise = runOnce(deps, cfg);
        await jest.runOnlyPendingTimersAsync();
        outcome = await runPromise;
      } finally {
        jest.useRealTimers();
      }

      expect(outcome.threshold).toBe(42);
      expect(outcome.addressesAboveThresholdToTrust).toEqual([trustedTarget]);
    } finally {
      if (previousEnvThreshold === undefined) {
        delete process.env.GNOSIS_GROUP_SCORE_THRESHOLD;
      } else {
        process.env.GNOSIS_GROUP_SCORE_THRESHOLD = previousEnvThreshold;
      }
    }
  });

  it("still filters blacklisted avatars in dry-run mode", async () => {
    const blockedRaw = "0x6000000000000000000000000000000000000006";
    const allowedRaw = "0x7000000000000000000000000000000000000007";
    const blockedAddress = getAddress(blockedRaw);
    const allowedAddress = getAddress(allowedRaw);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [blockedAddress, allowedAddress];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [];

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(new Set([blockedAddress.toLowerCase()])),
      circlesRpc,
      logger: new FakeLogger(true)
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: true,
      scoreThreshold: 10,
      scoreBatchSize: 10,
      groupBatchSize: 10
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [{address: allowedAddress, relative_score: 50}]
        }
      })
    });

    const outcome = await runOnce(deps, cfg);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.allowedAvatars).toContain(allowedAddress);
    expect(outcome.allowedAvatars).not.toContain(blockedAddress);
    expect(outcome.blacklistedAvatars).toContain(blockedAddress);
    expect(outcome.addressesQueuedForTrust).toContain(allowedAddress);
    expect(outcome.addressesQueuedForTrust).not.toContain(blockedAddress);
    expect(outcome.addressesToUntrust).toEqual([]);
    expect(outcome.untrustBatches).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("only submits trust transactions for addresses not already trusted by the target group", async () => {
    const alreadyTrustedRaw = "0x8000000000000000000000000000000000000008";
    const eligibleRaw = "0x9000000000000000000000000000000000000009";
    const alreadyTrusted = getAddress(alreadyTrustedRaw);
    const eligible = getAddress(eligibleRaw);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [alreadyTrusted, eligible];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [alreadyTrusted];

    const groupService = new FakeGroupService();

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true),
      groupService
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: false,
      scoreThreshold: 10,
      scoreBatchSize: 10,
      groupBatchSize: 10
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [
            {address: alreadyTrusted, relative_score: 75},
            {address: eligible, relative_score: 80}
          ]
        }
      })
    });

    const outcome = await runOnce(deps, cfg);

    expect(groupService.trustCalls).toBe(1);
    const call = groupService.calls[0];
    expect(call.groupAddress).toBe(targetGroup);
    expect(call.trusteeAddresses).toEqual([eligible, trustedTarget]);
    expect(outcome.addressesQueuedForTrust).toEqual([eligible, trustedTarget]);
    expect(outcome.trustTxHashes).toHaveLength(1);
    expect(groupService.untrustCalls).toBe(0);
    expect(outcome.addressesToUntrust).toEqual([]);
    expect(outcome.untrustBatches).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("retries trust batches that fail initially and processes remaining batches", async () => {
    const first = getAddress("0xa00000000000000000000000000000000000000a");
    const second = getAddress("0xb00000000000000000000000000000000000000b");
    const third = getAddress("0xc00000000000000000000000000000000000000c");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [first, second, third];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [];

    const groupService = new FlakyGroupService();
    groupService.setTrustFailure(targetGroup, [first], 1);

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true),
      groupService
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: false,
      scoreThreshold: 10,
      scoreBatchSize: 10,
      groupBatchSize: 1
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [
            {address: first, relative_score: 100},
            {address: second, relative_score: 100},
            {address: third, relative_score: 100}
          ]
        }
      })
    });

    jest.useFakeTimers();
    try {
      const runPromise = runOnce(deps, cfg);
      await jest.runOnlyPendingTimersAsync();
      const outcome = await runPromise;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(groupService.trustAttempts).toBe(5);
      expect(groupService.successfulTrustBatches).toBe(4);
      expect(outcome.trustTxHashes).toHaveLength(4);
      expect(groupService.calls.filter((call) => call.type === "trust")).toHaveLength(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it("continues processing subsequent trust batches but surfaces errors when retries fail", async () => {
    const failing = getAddress("0xd00000000000000000000000000000000000000d");
    const succeeding = getAddress("0xe00000000000000000000000000000000000000e");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [failing, succeeding];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [];

    const groupService = new FlakyGroupService();
    groupService.setTrustFailure(targetGroup, [failing], 5);

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true),
      groupService
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: false,
      scoreThreshold: 10,
      scoreBatchSize: 10,
      groupBatchSize: 1
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [
            {address: failing, relative_score: 100},
            {address: succeeding, relative_score: 100}
          ]
        }
      })
    });

    jest.useFakeTimers();
    try {
      const runPromise = runOnce(deps, cfg);
      const expectation = expect(runPromise).rejects.toThrow(/Failed to process 1 group batch/);
      await jest.runOnlyPendingTimersAsync();
      await jest.runOnlyPendingTimersAsync();
      await jest.runOnlyPendingTimersAsync();
      await expectation;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(groupService.trustAttempts).toBeGreaterThanOrEqual(4);
      expect(groupService.calls.filter((call) => call.type === "trust" && call.trusteeAddresses.includes(succeeding))).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("untrusts previously trusted addresses that no longer satisfy criteria", async () => {
    const staleRaw = "0xa00000000000000000000000000000000000000a";
    const activeRaw = "0xb00000000000000000000000000000000000000b";
    const stale = getAddress(staleRaw);
    const active = getAddress(activeRaw);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [active];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [stale];

    const groupService = new FakeGroupService();

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true),
      groupService
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: false,
      scoreThreshold: 50,
      scoreBatchSize: 10,
      groupBatchSize: 10
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [{address: active, relative_score: 60}]
        }
      })
    });

    const outcome = await runOnce(deps, cfg);

    expect(groupService.untrustCalls).toBe(1);
    const untrustCall = groupService.calls.find(call => call.type === "untrust");
    expect(untrustCall?.groupAddress).toBe(targetGroup);
    expect(untrustCall?.trusteeAddresses).toEqual([stale]);
    expect(outcome.addressesToUntrust).toEqual([stale]);
    expect(outcome.untrustTxHashes).toEqual(["0xuntrust_1"]);
    expect(outcome.untrustBatches).toEqual([[stale]]);
  });

  it("logs dry-run untrust batches when stale trustees remain", async () => {
    const stale = getAddress("0xc00000000000000000000000000000000000000c");
    const active = getAddress("0xd00000000000000000000000000000000000000d");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [active];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [stale];

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true)
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: true,
      scoreThreshold: 50,
      scoreBatchSize: 10,
      groupBatchSize: 1
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [{address: active, relative_score: 80}]
        }
      })
    });

    const outcome = await runOnce(deps, cfg);

    expect(outcome.addressesToUntrust).toEqual([stale]);
    expect(outcome.untrustBatches).toEqual([[stale]]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("summarizes failed untrust batches after exhausting retries", async () => {
    const stale = getAddress("0xe00000000000000000000000000000000000000e");
    const active = getAddress("0xf00000000000000000000000000000000000000f");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [active];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [stale];

    const groupService = new FlakyGroupService();
    groupService.setUntrustFailure(targetGroup, [stale], 5);

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true),
      groupService
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: false,
      scoreThreshold: 50,
      scoreBatchSize: 10,
      groupBatchSize: 1
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [{address: active, relative_score: 90}]
        }
      })
    });

    jest.useFakeTimers();
    try {
      const runPromise = runOnce(deps, cfg);
      const expectation = expect(runPromise).rejects.toThrow(/Failed to process 1 group batch/);
      await jest.runOnlyPendingTimersAsync();
      await jest.runOnlyPendingTimersAsync();
      await jest.runOnlyPendingTimersAsync();
      await expectation;
      expect(groupService.untrustAttempts).toBeGreaterThanOrEqual(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("throws when configured target group address is invalid", async () => {
    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc: new FakeCirclesRpc(),
      logger: new FakeLogger(true)
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: "not-an-address",
      backersGroupAddress: circlesBackerGroup,
      dryRun: true
    };

    await expect(runOnce(deps, cfg)).rejects.toThrow("Invalid target group address configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("requires a group service when not running in dry-run mode", async () => {
    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc: new FakeCirclesRpc(),
      logger: new FakeLogger(true)
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: false
    };

    await expect(runOnce(deps, cfg)).rejects.toThrow(
      "Group service dependency is required when gnosis-group is not running in dry-run mode"
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns early when the RegisterHuman table is empty", async () => {
    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [];

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true)
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: true
    };

    const outcome = await runOnce(deps, cfg);

    expect(outcome.totalHumanAvatars).toBe(0);
    expect(outcome.uniqueHumanAvatars).toBe(0);
    expect(outcome.allowedAvatars).toEqual([]);
    expect(outcome.blacklistedAvatars).toEqual([]);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("trusts below-threshold avatars guaranteed by configured auto-trust groups", async () => {
    const autoTrustedRaw = "0xc00000000000000000000000000000000000000c";
    const autoTrusted = getAddress(autoTrustedRaw);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [autoTrusted];
    circlesRpc.trusteesByTruster[circlesBackerGroup.toLowerCase()] = [trustedTarget];
    circlesRpc.trusteesByTruster[targetGroup.toLowerCase()] = [];
    circlesRpc.trusteesByTruster[customAutoTrustGroup.toLowerCase()] = [autoTrusted];

    const groupService = new FakeGroupService();

    const deps: Deps = {
      blacklistingService: new FakeBlacklist(),
      circlesRpc,
      logger: new FakeLogger(true),
      groupService
    };

    const cfg: RunConfig = {
      rpcUrl: "https://rpc.local",
      scoringServiceUrl: "https://scores.local",
      autoTrustGroupAddresses: [circlesBackerGroup, customAutoTrustGroup],
      targetGroupAddress: targetGroup,
      backersGroupAddress: circlesBackerGroup,
      dryRun: false,
      scoreThreshold: 50,
      scoreBatchSize: 10,
      groupBatchSize: 10
    };

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [{address: autoTrusted, relative_score: 25}]
        }
      })
    });

    const outcome = await runOnce(deps, cfg);

    expect(groupService.trustCalls).toBe(1);
    const trustCall = groupService.calls.find(call => call.type === "trust");
    expect(trustCall?.trusteeAddresses).toEqual([autoTrusted, trustedTarget]);
    expect(outcome.addressesAboveThresholdToTrust).toEqual([]);
    expect(outcome.addressesAutoTrustedByGroups).toEqual([autoTrusted, trustedTarget]);
    expect(outcome.addressesQueuedForTrust).toEqual([autoTrusted, trustedTarget]);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
    const [, fetchInit] = fetchMock.mock.calls[0] ?? [];
    const requestBody = JSON.parse((fetchInit?.body ?? "{}") as string);
    expect(requestBody.target_sets).toEqual([[trustedTarget]]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });
});
