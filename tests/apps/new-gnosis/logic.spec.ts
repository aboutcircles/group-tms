import {
  DEFAULT_SCORE_THRESHOLD,
  runBackfill,
  runIncremental,
  type RunConfig,
  type RunDeps
} from "../../../src/apps/new-gnosis/logic";
import {FakeLogger} from "../../../fakes/fakes";

const CUTOFF_BLOCK = 1_000;

const AVATAR_OLD_GOOD = "0x1111111111111111111111111111111111111111";
const AVATAR_OLD_BLACKLISTED = "0x2222222222222222222222222222222222222222";
const AVATAR_OLD_LOW_SCORE = "0x3333333333333333333333333333333333333333";
const AVATAR_OLD_TRUSTED = "0x4444444444444444444444444444444444444444";
const AVATAR_OLD_UNCLAIMED = "0x5555555555555555555555555555555555555555";
const AVATAR_OLD_OPTED_OUT = "0x6666666666666666666666666666666666666666";
const AVATAR_NEW_BLACKLISTED = "0x7777777777777777777777777777777777777777";
const AVATAR_NEW_LOW_SCORE = "0x8888888888888888888888888888888888888888";
const AVATAR_OLD_NOT_HUMAN = "0x9999999999999999999999999999999999999999";
const AVATAR_NEW_NOT_HUMAN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AVATAR_OLD_UNTRUSTABLE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AVATAR_NEW_UNTRUSTABLE = "0xcccccccccccccccccccccccccccccccccccccccc";

type UserRow = { id: string; createdAtBlock: number };

function indexerPayload(rows: UserRow[]): unknown {
  return {data: {GnosisAppUser: rows}};
}

function makeConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    indexerUrl: "http://indexer.test",
    contractAddress: "0x93eD5A96347927ff6fF6b790F8Cf5258240c321f",
    cutoffBlock: CUTOFF_BLOCK,
    scoreThreshold: DEFAULT_SCORE_THRESHOLD,
    fetchPageSize: 100,
    trustBatchSize: 20,
    fetchTimeoutMs: 1_000,
    dryRun: false,
    ...overrides
  };
}

type DepsOverrides = {
  users?: UserRow[];
  registered?: string[];
  existingTrustees?: string[];
  blacklisted?: string[];
  scores?: Record<string, number>;
  optedOut?: string[];
  notHuman?: string[];
  untrustable?: string[];
};

function makeDeps(overrides: DepsOverrides = {}): RunDeps & {
  trustedBatches: string[][];
  queries: string[];
  scoreRequests: string[][];
  blacklistRequests: string[][];
  trustSimulationRequests: string[][];
} {
  const users = overrides.users ?? [];
  const registered = (overrides.registered ?? users.map((u) => u.id)).map((a) => a.toLowerCase());
  const existingTrustees = overrides.existingTrustees ?? [];
  const blacklisted = (overrides.blacklisted ?? []).map((a) => a.toLowerCase());
  const scores = overrides.scores ?? {};
  const optedOut = (overrides.optedOut ?? []).map((a) => a.toLowerCase());
  const notHuman = (overrides.notHuman ?? []).map((a) => a.toLowerCase());
  const untrustable = (overrides.untrustable ?? []).map((a) => a.toLowerCase());

  const trustedBatches: string[][] = [];
  const queries: string[] = [];
  const scoreRequests: string[][] = [];
  const blacklistRequests: string[][] = [];
  const trustSimulationRequests: string[][] = [];

  return {
    trustedBatches,
    queries,
    scoreRequests,
    blacklistRequests,
    trustSimulationRequests,
    fetchUsers: async (query: string) => {
      queries.push(query);
      const filtered = query.includes("_lt:")
        ? users.filter((u) => u.createdAtBlock < CUTOFF_BLOCK)
        : users.filter((u) => u.createdAtBlock >= CUTOFF_BLOCK);
      return indexerPayload(filtered);
    },
    fetchExistingTrustees: async () => [...existingTrustees],
    filterRegisteredHumans: async (addresses: string[]) =>
      new Set(addresses.map((a) => a.toLowerCase()).filter((a) => registered.includes(a))),
    filterHumanAvatars: async (addresses: string[]) =>
      new Set(addresses.map((a) => a.toLowerCase()).filter((a) => !notHuman.includes(a))),
    isOptedOutBatch: async (addresses: string[]) =>
      new Map(addresses.map((a) => [a.toLowerCase(), optedOut.includes(a.toLowerCase())])),
    checkBlacklist: async (addresses: string[]) => {
      blacklistRequests.push([...addresses]);
      return new Set(addresses.map((a) => a.toLowerCase()).filter((a) => blacklisted.includes(a)));
    },
    fetchTrustScores: async (addresses: string[]) => {
      scoreRequests.push([...addresses]);
      const result = new Map<string, number>();
      for (const address of addresses) {
        const lower = address.toLowerCase();
        if (lower in scores) {
          result.set(lower, scores[lower]);
        }
      }
      return result;
    },
    filterTrustable: async (addresses: string[]) => {
      trustSimulationRequests.push([...addresses]);
      return new Set(addresses.map((a) => a.toLowerCase()).filter((a) => !untrustable.includes(a)));
    },
    trustBatch: async (_contract: string, avatars: string[]) => {
      trustedBatches.push([...avatars]);
      return `0xtx_${trustedBatches.length}`;
    },
    logger: new FakeLogger(true)
  };
}

describe("new-gnosis runBackfill", () => {
  it("trusts pre-cutoff avatars only when not blacklisted and score above threshold", async () => {
    const deps = makeDeps({
      users: [
        {id: AVATAR_OLD_GOOD, createdAtBlock: 100},
        {id: AVATAR_OLD_BLACKLISTED, createdAtBlock: 200},
        {id: AVATAR_OLD_LOW_SCORE, createdAtBlock: 300}
      ],
      blacklisted: [AVATAR_OLD_BLACKLISTED],
      scores: {
        [AVATAR_OLD_GOOD]: 80,
        [AVATAR_OLD_LOW_SCORE]: 50
      }
    });

    const outcome = await runBackfill(deps, makeConfig());

    expect(outcome.fetchedUsers).toBe(3);
    expect(outcome.blacklistedCount).toBe(1);
    expect(outcome.belowThresholdCount).toBe(1);
    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([AVATAR_OLD_GOOD]);
    expect(deps.trustedBatches.flat().map((a) => a.toLowerCase())).toEqual([AVATAR_OLD_GOOD]);
    expect(outcome.trustTxHashes).toEqual(["0xtx_1"]);
  });

  it("treats a score exactly at the threshold as below it", async () => {
    const deps = makeDeps({
      users: [{id: AVATAR_OLD_GOOD, createdAtBlock: 100}],
      scores: {[AVATAR_OLD_GOOD]: DEFAULT_SCORE_THRESHOLD}
    });

    const outcome = await runBackfill(deps, makeConfig());

    expect(outcome.belowThresholdCount).toBe(1);
    expect(outcome.newAvatars).toEqual([]);
    expect(deps.trustedBatches).toEqual([]);
  });

  it("treats avatars without a score as score 0", async () => {
    const deps = makeDeps({
      users: [{id: AVATAR_OLD_GOOD, createdAtBlock: 100}],
      scores: {}
    });

    const outcome = await runBackfill(deps, makeConfig());

    expect(outcome.belowThresholdCount).toBe(1);
    expect(outcome.newAvatars).toEqual([]);
  });

  it("skips unclaimed, already trusted and opted-out avatars before scoring", async () => {
    const deps = makeDeps({
      users: [
        {id: AVATAR_OLD_GOOD, createdAtBlock: 100},
        {id: AVATAR_OLD_UNCLAIMED, createdAtBlock: 200},
        {id: AVATAR_OLD_TRUSTED, createdAtBlock: 300},
        {id: AVATAR_OLD_OPTED_OUT, createdAtBlock: 400}
      ],
      registered: [AVATAR_OLD_GOOD, AVATAR_OLD_TRUSTED, AVATAR_OLD_OPTED_OUT],
      existingTrustees: [AVATAR_OLD_TRUSTED],
      optedOut: [AVATAR_OLD_OPTED_OUT],
      scores: {
        [AVATAR_OLD_GOOD]: 90,
        [AVATAR_OLD_OPTED_OUT]: 90
      }
    });

    const outcome = await runBackfill(deps, makeConfig());

    expect(outcome.unclaimedCount).toBe(1);
    expect(outcome.alreadyTrustedCount).toBe(1);
    expect(outcome.optedOutCount).toBe(1);
    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([AVATAR_OLD_GOOD]);
    // already-trusted avatars must not be sent to the scoring service
    expect(deps.scoreRequests.flat().map((a) => a.toLowerCase())).not.toContain(AVATAR_OLD_TRUSTED);
  });

  it("drops avatars that fail the on-chain human check before batching", async () => {
    const deps = makeDeps({
      users: [
        {id: AVATAR_OLD_GOOD, createdAtBlock: 100},
        {id: AVATAR_OLD_NOT_HUMAN, createdAtBlock: 200}
      ],
      scores: {
        [AVATAR_OLD_GOOD]: 80,
        [AVATAR_OLD_NOT_HUMAN]: 80
      },
      notHuman: [AVATAR_OLD_NOT_HUMAN]
    });

    const outcome = await runBackfill(deps, makeConfig());

    expect(outcome.notHumanCount).toBe(1);
    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([AVATAR_OLD_GOOD]);
    expect(deps.trustedBatches.flat().map((a) => a.toLowerCase())).toEqual([AVATAR_OLD_GOOD]);
  });

  it("drops avatars whose trust() simulation reverts before batching", async () => {
    const deps = makeDeps({
      users: [
        {id: AVATAR_OLD_GOOD, createdAtBlock: 100},
        {id: AVATAR_OLD_UNTRUSTABLE, createdAtBlock: 200}
      ],
      scores: {
        [AVATAR_OLD_GOOD]: 80,
        [AVATAR_OLD_UNTRUSTABLE]: 80
      },
      untrustable: [AVATAR_OLD_UNTRUSTABLE]
    });

    const outcome = await runBackfill(deps, makeConfig());

    expect(outcome.untrustableCount).toBe(1);
    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([AVATAR_OLD_GOOD]);
    expect(deps.trustedBatches.flat().map((a) => a.toLowerCase())).toEqual([AVATAR_OLD_GOOD]);
  });

  it("only queries users registered before the cutoff block", async () => {
    const deps = makeDeps({users: []});

    await runBackfill(deps, makeConfig());

    expect(deps.queries[0]).toContain(`createdAtBlock:{_lt:${CUTOFF_BLOCK}}`);
  });

  it("does not execute trust batches in dry-run mode", async () => {
    const deps = makeDeps({
      users: [{id: AVATAR_OLD_GOOD, createdAtBlock: 100}],
      scores: {[AVATAR_OLD_GOOD]: 80}
    });

    const outcome = await runBackfill(deps, makeConfig({dryRun: true}));

    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([AVATAR_OLD_GOOD]);
    expect(outcome.trustBatches).toHaveLength(1);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(deps.trustedBatches).toEqual([]);
  });

  it("throws when no trustBatch executor is provided outside dry-run", async () => {
    const deps = makeDeps();
    deps.trustBatch = undefined;

    await expect(runBackfill(deps, makeConfig())).rejects.toThrow("trustBatch executor is required");
  });
});

describe("new-gnosis runIncremental", () => {
  it("trusts post-cutoff avatars irrespective of blacklist and trust score", async () => {
    const deps = makeDeps({
      users: [
        {id: AVATAR_NEW_BLACKLISTED, createdAtBlock: 1_500},
        {id: AVATAR_NEW_LOW_SCORE, createdAtBlock: 2_000}
      ],
      blacklisted: [AVATAR_NEW_BLACKLISTED],
      scores: {[AVATAR_NEW_LOW_SCORE]: 1}
    });

    const outcome = await runIncremental(deps, makeConfig());

    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([
      AVATAR_NEW_BLACKLISTED,
      AVATAR_NEW_LOW_SCORE
    ]);
    expect(deps.trustedBatches.flat()).toHaveLength(2);
    // neither the blacklist nor the scoring service may be consulted
    expect(deps.blacklistRequests).toEqual([]);
    expect(deps.scoreRequests).toEqual([]);
    expect(outcome.highestBlockSeen).toBe(2_000);
  });

  it("queries users registered at or after the cutoff block", async () => {
    const deps = makeDeps({users: []});

    await runIncremental(deps, makeConfig());

    expect(deps.queries[0]).toContain(`createdAtBlock:{_gte:${CUTOFF_BLOCK}}`);
  });

  it("still respects opt-out, registration and already-trusted filters", async () => {
    const deps = makeDeps({
      users: [
        {id: AVATAR_NEW_BLACKLISTED, createdAtBlock: 1_100},
        {id: AVATAR_OLD_UNCLAIMED, createdAtBlock: 1_200},
        {id: AVATAR_OLD_TRUSTED, createdAtBlock: 1_300},
        {id: AVATAR_OLD_OPTED_OUT, createdAtBlock: 1_400}
      ],
      registered: [AVATAR_NEW_BLACKLISTED, AVATAR_OLD_TRUSTED, AVATAR_OLD_OPTED_OUT],
      existingTrustees: [AVATAR_OLD_TRUSTED],
      optedOut: [AVATAR_OLD_OPTED_OUT]
    });

    const outcome = await runIncremental(deps, makeConfig());

    expect(outcome.unclaimedCount).toBe(1);
    expect(outcome.alreadyTrustedCount).toBe(1);
    expect(outcome.optedOutCount).toBe(1);
    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([AVATAR_NEW_BLACKLISTED]);
  });

  it("drops avatars that fail the on-chain human check before batching", async () => {
    const deps = makeDeps({
      users: [
        {id: AVATAR_NEW_LOW_SCORE, createdAtBlock: 1_100},
        {id: AVATAR_NEW_NOT_HUMAN, createdAtBlock: 1_200}
      ],
      notHuman: [AVATAR_NEW_NOT_HUMAN]
    });

    const outcome = await runIncremental(deps, makeConfig());

    expect(outcome.notHumanCount).toBe(1);
    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([AVATAR_NEW_LOW_SCORE]);
    expect(deps.trustedBatches.flat().map((a) => a.toLowerCase())).toEqual([AVATAR_NEW_LOW_SCORE]);
  });

  it("drops avatars whose trust() simulation reverts before batching", async () => {
    const deps = makeDeps({
      users: [
        {id: AVATAR_NEW_LOW_SCORE, createdAtBlock: 1_100},
        {id: AVATAR_NEW_UNTRUSTABLE, createdAtBlock: 1_200},
        {id: AVATAR_NEW_NOT_HUMAN, createdAtBlock: 1_300}
      ],
      notHuman: [AVATAR_NEW_NOT_HUMAN],
      untrustable: [AVATAR_NEW_UNTRUSTABLE]
    });

    const outcome = await runIncremental(deps, makeConfig());

    expect(outcome.untrustableCount).toBe(1);
    expect(outcome.notHumanCount).toBe(1);
    expect(outcome.newAvatars.map((a) => a.toLowerCase())).toEqual([AVATAR_NEW_LOW_SCORE]);
    expect(deps.trustedBatches.flat().map((a) => a.toLowerCase())).toEqual([AVATAR_NEW_LOW_SCORE]);
    // avatars removed by earlier filters must not be simulated
    expect(deps.trustSimulationRequests.flat().map((a) => a.toLowerCase())).not.toContain(AVATAR_NEW_NOT_HUMAN);
  });

  it("splits avatars into trust batches of the configured size", async () => {
    const users = Array.from({length: 5}, (_, i) => ({
      id: `0x${String(i + 1).repeat(40)}`.slice(0, 42),
      createdAtBlock: 1_100 + i
    }));
    const deps = makeDeps({users});

    const outcome = await runIncremental(deps, makeConfig({trustBatchSize: 2}));

    expect(outcome.trustBatches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(deps.trustedBatches).toHaveLength(3);
  });
});
