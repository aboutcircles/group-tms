import {mergeHybridMembers} from "../../../src/apps/community-new/oldRegistrySource";

// Lowercased avatar addresses (mergeHybridMembers compares by set membership).
const TEST_A = "0xaaaa000000000000000000000000000000000001";
const TEST_B = "0xaaaa000000000000000000000000000000000002";
const OLD_MEMBER = "0xbbbb000000000000000000000000000000000001";
const NEW_ONLY = "0xcccc000000000000000000000000000000000001";

describe("mergeHybridMembers", () => {
  it("governs non-test avatars by OLD registry and test avatars by NEW registry", () => {
    const testAddresses = new Set([TEST_A]);
    // OLD has a normal member + a test address; NEW has that test address + a non-test address.
    const oldMembers = new Set([OLD_MEMBER, TEST_A]);
    const newMembers = new Set([TEST_A, NEW_ONLY]);

    const merged = mergeHybridMembers(oldMembers, newMembers, testAddresses);

    // OLD_MEMBER kept (non-test, from OLD); TEST_A from NEW (test); NEW_ONLY dropped (non-test, NEW-only).
    expect(merged).toEqual(new Set([OLD_MEMBER, TEST_A]));
  });

  it("drops a test address that is in OLD but absent from NEW (switched to NEW governance)", () => {
    const merged = mergeHybridMembers(new Set([TEST_A]), new Set(), new Set([TEST_A]));
    expect(merged).toEqual(new Set());
  });

  it("adds a test address present only in NEW (its multi-group membership)", () => {
    const merged = mergeHybridMembers(new Set(), new Set([TEST_A, TEST_B]), new Set([TEST_A, TEST_B]));
    expect(merged).toEqual(new Set([TEST_A, TEST_B]));
  });

  it("with an empty test allowlist is identical to pure OLD membership", () => {
    const oldMembers = new Set([OLD_MEMBER, TEST_A]);
    const newMembers = new Set([NEW_ONLY]);
    const merged = mergeHybridMembers(oldMembers, newMembers, new Set());
    expect(merged).toEqual(oldMembers);
  });

  it("ignores NEW-registry membership for non-test avatars", () => {
    // NEW_ONLY joined a group via the new registry but is NOT a test address →
    // must be ignored (prod behavior unchanged for everyone but test devs).
    const merged = mergeHybridMembers(new Set([OLD_MEMBER]), new Set([NEW_ONLY]), new Set([TEST_A]));
    expect(merged).toEqual(new Set([OLD_MEMBER]));
  });
});
