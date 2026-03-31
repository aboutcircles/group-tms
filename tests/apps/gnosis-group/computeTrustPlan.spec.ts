import {getAddress} from "ethers";
import {computeTrustPlan} from "../../../src/apps/gnosis-group/logic";

function makeAddress(index: number): string {
  const hex = index.toString(16).padStart(40, "0");
  return `0x${hex}`;
}

describe("computeTrustPlan", () => {
  it("includes addresses below threshold when guaranteed by configured groups", () => {
    const addr1 = makeAddress(1);
    const addr2 = makeAddress(2);
    const addr3 = makeAddress(3);

    const normalized1 = getAddress(addr1);
    const normalized2 = getAddress(addr2);
    const normalized3 = getAddress(addr3);

    const plan = computeTrustPlan({
      allowedAvatars: [addr1, addr2, addr3],
      scores: {
        [normalized1]: 75,
        [normalized2]: 25,
        [normalized3]: 80
      },
      scoreThreshold: 50,
      guaranteedAddresses: [normalized2],
      existingTargetGroupAddresses: [normalized3],
      batchSize: 10
    });

    expect(plan.addressesAboveThresholdToTrust).toEqual([normalized1]);
    expect(plan.addressesAutoTrustedByGroups).toEqual([normalized2]);
    expect(plan.addressesQueuedForTrust).toEqual([normalized1, normalized2]);
    expect(plan.trustBatches).toEqual([[normalized1, normalized2]]);
    expect(plan.addressesToUntrust).toEqual([]);
    expect(plan.untrustBatches).toEqual([]);
  });

  it("chunks queued addresses according to the configured batch size", () => {
    const allowed = Array.from({length: 23}, (_, index) => makeAddress(index + 1));

    const scores: Record<string, number> = {};
    const guaranteed: string[] = [];

    allowed.forEach((addr, index) => {
      const normalized = getAddress(addr);
      const aboveThreshold = index % 2 === 0;
      scores[normalized] = aboveThreshold ? 65 : 35;
      if (!aboveThreshold) {
        guaranteed.push(normalized);
      }
    });

    const plan = computeTrustPlan({
      allowedAvatars: allowed,
      scores,
      scoreThreshold: 50,
      guaranteedAddresses: guaranteed,
      existingTargetGroupAddresses: [],
      batchSize: 10
    });

    expect(plan.addressesQueuedForTrust).toHaveLength(23);
    expect(plan.trustBatches).toHaveLength(3);
    expect(plan.trustBatches[0]).toHaveLength(10);
    expect(plan.trustBatches[1]).toHaveLength(10);
    expect(plan.trustBatches[2]).toHaveLength(3);
    expect(plan.addressesToUntrust).toEqual([]);
    expect(plan.untrustBatches).toEqual([]);
  });

  it("identifies existing trustees that no longer satisfy criteria for untrust", () => {
    const addr1 = makeAddress(1);
    const addr2 = makeAddress(2);
    const addr3 = makeAddress(3);

    const normalized1 = getAddress(addr1);
    const normalized2 = getAddress(addr2);
    const normalized3 = getAddress(addr3);

    const plan = computeTrustPlan({
      allowedAvatars: [addr1, addr2],
      scores: {
        [normalized1]: 75,
        [normalized2]: 10
      },
      scoreThreshold: 50,
      guaranteedAddresses: [normalized1],
      existingTargetGroupAddresses: [normalized1, normalized2, normalized3],
      batchSize: 5
    });

    expect(plan.addressesQueuedForTrust).toEqual([]);
    expect(plan.addressesToUntrust).toEqual([normalized2, normalized3]);
    expect(plan.untrustBatches).toEqual([[normalized2, normalized3]]);
  });

  it("queues guaranteed addresses even when absent from allowed avatars", () => {
    const guaranteedOnly = makeAddress(99);
    const normalizedGuaranteed = getAddress(guaranteedOnly);

    const plan = computeTrustPlan({
      allowedAvatars: [],
      scores: {},
      scoreThreshold: 50,
      guaranteedAddresses: [normalizedGuaranteed],
      existingTargetGroupAddresses: [],
      batchSize: 5
    });

    expect(plan.addressesQueuedForTrust).toEqual([normalizedGuaranteed]);
    expect(plan.addressesAutoTrustedByGroups).toEqual([normalizedGuaranteed]);
    expect(plan.trustBatches).toEqual([[normalizedGuaranteed]]);
  });

  it("ignores invalid and duplicate addresses across planner inputs", () => {
    const allowed = makeAddress(10);
    const normalizedAllowed = getAddress(allowed);
    const existing = makeAddress(11);
    const normalizedExisting = getAddress(existing);

    const plan = computeTrustPlan({
      allowedAvatars: [allowed, "bad-address", allowed.toLowerCase()],
      scores: {[normalizedAllowed.toLowerCase()]: 70},
      scoreThreshold: 50,
      guaranteedAddresses: ["bad-address", normalizedAllowed, normalizedAllowed.toLowerCase()],
      existingTargetGroupAddresses: [normalizedExisting, "bad-address", normalizedExisting.toLowerCase()],
      batchSize: 0
    });

    expect(plan.addressesQueuedForTrust).toEqual([normalizedAllowed]);
    expect(plan.trustBatches).toEqual([[normalizedAllowed]]);
    expect(plan.addressesToUntrust).toEqual([normalizedExisting, normalizedExisting]);
    expect(plan.untrustBatches).toEqual([[normalizedExisting], [normalizedExisting]]);
  });
});
