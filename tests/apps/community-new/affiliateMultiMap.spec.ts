import {AffiliateMultiMap} from "../../../src/apps/community-new/affiliateMultiMap";

const AVATAR = "0x1000000000000000000000000000000000000001";
const AVATAR_2 = "0x2000000000000000000000000000000000000002";
const GROUP_A = "0x4e2564e5df6c1fb10c1a018538de36e4d5844de5";
const GROUP_B = "0x2709757a543cf1bf4d92586b73d3891438b2589d";
const GROUP_C = "0xeecae593589a6ee4a12ae64f19420b47f3112fa9";

describe("AffiliateMultiMap", () => {
  it("holds several groups per avatar simultaneously (multi-membership)", () => {
    const map = new AffiliateMultiMap();
    map.add(AVATAR, GROUP_A);
    map.add(AVATAR, GROUP_B);
    map.add(AVATAR, GROUP_C);

    expect(map.getGroups(AVATAR)).toEqual([GROUP_B, GROUP_C, GROUP_A].sort());
    expect(map.getMembersOf(GROUP_A)).toEqual(new Set([AVATAR]));
    expect(map.getMembersOf(GROUP_B)).toEqual(new Set([AVATAR]));
  });

  it("indexes members per group across avatars", () => {
    const map = new AffiliateMultiMap();
    map.add(AVATAR, GROUP_A);
    map.add(AVATAR_2, GROUP_A);
    expect(map.getMembersOf(GROUP_A)).toEqual(new Set([AVATAR, AVATAR_2]));
  });

  it("removes a single membership without touching the others", () => {
    const map = new AffiliateMultiMap();
    map.add(AVATAR, GROUP_A);
    map.add(AVATAR, GROUP_B);
    map.remove(AVATAR, GROUP_A);

    expect(map.getGroups(AVATAR)).toEqual([GROUP_B]);
    expect(map.getMembersOf(GROUP_A).size).toBe(0);
    expect(map.getMembersOf(GROUP_B)).toEqual(new Set([AVATAR]));
  });

  it("is idempotent on duplicate add and no-op remove", () => {
    const map = new AffiliateMultiMap();
    map.add(AVATAR, GROUP_A);
    map.add(AVATAR, GROUP_A);
    expect(map.getMembersOf(GROUP_A)).toEqual(new Set([AVATAR]));
    map.remove(AVATAR_2, GROUP_A); // never a member
    expect(map.getMembersOf(GROUP_A)).toEqual(new Set([AVATAR]));
  });

  it("normalizes address casing", () => {
    const map = new AffiliateMultiMap();
    map.add(AVATAR.toUpperCase().replace("0X", "0x"), GROUP_A.toUpperCase().replace("0X", "0x"));
    expect(map.getMembersOf(GROUP_A)).toEqual(new Set([AVATAR]));
  });

  it("round-trips through a snapshot and advances the scan cursor", () => {
    const map = new AffiliateMultiMap(100);
    map.add(AVATAR, GROUP_A, 150);
    map.add(AVATAR, GROUP_B, 160);
    map.add(AVATAR_2, GROUP_A, 170);

    const snapshot = map.snapshot();
    expect(snapshot.lastScannedBlock).toBe(170);

    const restored = AffiliateMultiMap.fromSnapshot(snapshot);
    expect(restored.getGroups(AVATAR)).toEqual([GROUP_B, GROUP_A].sort());
    expect(restored.getMembersOf(GROUP_A)).toEqual(new Set([AVATAR, AVATAR_2]));
    expect(restored.lastScannedBlock).toBe(170);
    expect(restored.dirty).toBe(false);
  });

  it("tracks dirty state and cursor advancement", () => {
    const map = new AffiliateMultiMap(100);
    expect(map.dirty).toBe(false);
    map.add(AVATAR, GROUP_A, 120);
    expect(map.dirty).toBe(true);
    expect(map.lastScannedBlock).toBe(120);
    map.advanceCursor(130);
    expect(map.lastScannedBlock).toBe(130);
  });
});
