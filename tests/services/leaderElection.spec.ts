import {getEffectiveDryRun} from "../../src/services/leaderElection";

describe("getEffectiveDryRun", () => {
  it("returns dryRun when no leader election", () => {
    expect(getEffectiveDryRun(null, false)).toBe(false);
    expect(getEffectiveDryRun(null, true)).toBe(true);
  });

  it("returns true when leader election active but not leader", () => {
    const le = {isLeader: false} as any;
    expect(getEffectiveDryRun(le, false)).toBe(true);
    expect(getEffectiveDryRun(le, true)).toBe(true);
  });

  it("returns dryRun when leader election active and is leader", () => {
    const le = {isLeader: true} as any;
    expect(getEffectiveDryRun(le, false)).toBe(false);
    expect(getEffectiveDryRun(le, true)).toBe(true);
  });
});
