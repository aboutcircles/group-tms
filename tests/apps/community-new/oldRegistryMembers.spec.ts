import {reduceOldRegistryMembers} from "../../../src/apps/community-new/oldRegistryMembers";
import {AffiliateMap} from "../../../src/apps/group-affiliates/affiliateMap";
import {AffiliateGroupChanged} from "../../../src/interfaces/IAffiliateGroupEventsService";

const ZERO = "0x0000000000000000000000000000000000000000";
const GROUPS = [
  "0x1000000000000000000000000000000000000001",
  "0x1000000000000000000000000000000000000002",
  "0x1000000000000000000000000000000000000003"
];
const HUMANS = Array.from({length: 12}, (_, i) => `0x2${(i + 1).toString(16).padStart(39, "0")}`);

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stream shaped like the real registry: after a human's first event, every
 * event's oldGroup is their previous newGroup. A first event may carry a
 * nonzero oldGroup (3,791 of 6,871 real events do), a move may leave (newGroup
 * zero) and a move may name the group the human is already in.
 */
function randomStream(seed: number, length: number): AffiliateGroupChanged[] {
  const next = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const current = new Map<string, string>();
  const events: AffiliateGroupChanged[] = [];
  for (let i = 0; i < length; i++) {
    const human = pick(HUMANS);
    const oldGroup = current.get(human) ?? (next() < 0.5 ? pick(GROUPS) : ZERO);
    const roll = next();
    const newGroup = roll < 0.15 ? ZERO : roll < 0.25 ? oldGroup : pick(GROUPS);
    current.set(human, newGroup);
    events.push({blockNumber: 100 + i, txHash: `0x${i.toString(16)}`, human, oldGroup, newGroup});
  }
  return events;
}

function viaAffiliateMap(events: readonly AffiliateGroupChanged[], group: string): Set<string> {
  const map = new AffiliateMap(0);
  for (const event of events) map.set(event.human, event.newGroup, event.blockNumber);
  return new Set(map.getAffiliatesOf(group));
}

describe("reduceOldRegistryMembers", () => {
  it("keeps a human whose move names the group they are already in", () => {
    const [group] = GROUPS;
    const [human] = HUMANS;
    const events: AffiliateGroupChanged[] = [
      {blockNumber: 1, txHash: "0x1", human, oldGroup: ZERO, newGroup: group},
      {blockNumber: 2, txHash: "0x2", human, oldGroup: group, newGroup: group}
    ];
    expect(reduceOldRegistryMembers(events, group)).toEqual(new Set([human]));
  });

  it("removes a human who moves to another group or leaves", () => {
    const [groupA, groupB] = GROUPS;
    const [moves, leaves] = HUMANS;
    const events: AffiliateGroupChanged[] = [
      {blockNumber: 1, txHash: "0x1", human: moves, oldGroup: ZERO, newGroup: groupA},
      {blockNumber: 2, txHash: "0x2", human: leaves, oldGroup: ZERO, newGroup: groupA},
      {blockNumber: 3, txHash: "0x3", human: moves, oldGroup: groupA, newGroup: groupB},
      {blockNumber: 4, txHash: "0x4", human: leaves, oldGroup: groupA, newGroup: ZERO}
    ];
    expect(reduceOldRegistryMembers(events, groupA)).toEqual(new Set());
    expect(reduceOldRegistryMembers(events, groupB)).toEqual(new Set([moves]));
  });

  it("matches the AffiliateMap current-group index on 300 random streams", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const events = randomStream(seed, 60);
      for (const group of GROUPS) {
        const reduced = reduceOldRegistryMembers(events, group);
        const mapped = viaAffiliateMap(events, group);
        if (reduced.size !== mapped.size || [...reduced].some((h) => !mapped.has(h))) {
          throw new Error(`seed ${seed}, group ${group}: reduce=${[...reduced]} map=${[...mapped]}`);
        }
      }
    }
  });
});
