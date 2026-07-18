import {
  GRANDFATHER_ENV,
  countGrandfather,
  mergeProtectedTrustees,
  parseGrandfatherAddresses
} from "../../../src/apps/community-new/grandfather";

const GROUP_A = "0x4e2564e5df6c1fb10c1a018538de36e4d5844de5";
const GROUP_B = "0xeecae593589a6ee4a12ae64f19420b47f3112fa9";
const ADDR_1 = "0x154dff8fdd67102bc7f77d4f5c363e5c191833f3";
const ADDR_2 = "0x1e3438ea622c927a30f2977fdf1b36577bf9f6ef";

describe("parseGrandfatherAddresses", () => {
  it("returns an empty map for unset or blank input", () => {
    expect(parseGrandfatherAddresses(undefined)).toEqual({});
    expect(parseGrandfatherAddresses("")).toEqual({});
    expect(parseGrandfatherAddresses("   ")).toEqual({});
  });

  it("parses a per-group JSON object and lowercases group + avatar addresses", () => {
    const parsed = parseGrandfatherAddresses(
      JSON.stringify({[GROUP_A.toUpperCase().replace("0X", "0x")]: [ADDR_1, ADDR_2]})
    );
    expect(Object.keys(parsed)).toEqual([GROUP_A]);
    expect(parsed[GROUP_A]).toEqual(new Set([ADDR_1, ADDR_2]));
  });

  it("normalizes checksummed addresses to lowercase", () => {
    const checksummed = "0x154DFf8fdD67102Bc7F77d4F5C363E5c191833F3"; // EIP-55 form of ADDR_1
    const parsed = parseGrandfatherAddresses(JSON.stringify({[GROUP_A]: [checksummed]}));
    expect(parsed[GROUP_A]).toEqual(new Set([ADDR_1]));
  });

  it("dedupes repeated avatars within a group", () => {
    const parsed = parseGrandfatherAddresses(JSON.stringify({[GROUP_A]: [ADDR_1, ADDR_1]}));
    expect(parsed[GROUP_A].size).toBe(1);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseGrandfatherAddresses("{not json")).toThrow(GRANDFATHER_ENV);
  });

  it("throws when the top level is not an object", () => {
    expect(() => parseGrandfatherAddresses(JSON.stringify([ADDR_1]))).toThrow(GRANDFATHER_ENV);
    expect(() => parseGrandfatherAddresses(JSON.stringify("x"))).toThrow(GRANDFATHER_ENV);
  });

  it("throws when a group value is not an array", () => {
    expect(() => parseGrandfatherAddresses(JSON.stringify({[GROUP_A]: ADDR_1}))).toThrow(/must be an array/);
  });

  it("throws on an invalid group address", () => {
    expect(() => parseGrandfatherAddresses(JSON.stringify({"0xnotanaddress": [ADDR_1]})))
      .toThrow(/invalid group address/);
  });

  it("throws on an invalid avatar address", () => {
    expect(() => parseGrandfatherAddresses(JSON.stringify({[GROUP_A]: ["0xzzzz"]})))
      .toThrow(/invalid avatar address/);
  });

  it("throws on a non-string avatar entry", () => {
    expect(() => parseGrandfatherAddresses(JSON.stringify({[GROUP_A]: [42]})))
      .toThrow(/only address strings/);
  });
});

describe("countGrandfather", () => {
  it("sums addresses across groups", () => {
    expect(countGrandfather({})).toBe(0);
    expect(countGrandfather({[GROUP_A]: new Set([ADDR_1, ADDR_2]), [GROUP_B]: new Set([ADDR_1])})).toBe(3);
  });
});

describe("mergeProtectedTrustees", () => {
  it("unions the grandfather list into the base per group without mutating inputs", () => {
    const base = {[GROUP_A]: new Set([ADDR_1])};
    const grandfather = {[GROUP_A]: new Set([ADDR_2])};

    const merged = mergeProtectedTrustees(base, grandfather);

    expect(merged[GROUP_A]).toEqual(new Set([ADDR_1, ADDR_2]));
    // inputs untouched
    expect(base[GROUP_A]).toEqual(new Set([ADDR_1]));
    expect(grandfather[GROUP_A]).toEqual(new Set([ADDR_2]));
  });

  it("keeps groups isolated — a carve-out in one group does not leak into another", () => {
    const merged = mergeProtectedTrustees(
      {[GROUP_A]: new Set([ADDR_1]), [GROUP_B]: new Set<string>()},
      {[GROUP_A]: new Set([ADDR_2])}
    );
    expect(merged[GROUP_A]).toEqual(new Set([ADDR_1, ADDR_2]));
    expect(merged[GROUP_B]).toEqual(new Set<string>());
    expect(merged[GROUP_B].has(ADDR_2)).toBe(false);
  });

  it("includes groups that appear only in the grandfather list", () => {
    const merged = mergeProtectedTrustees({}, {[GROUP_A]: new Set([ADDR_1])});
    expect(merged[GROUP_A]).toEqual(new Set([ADDR_1]));
  });
});
