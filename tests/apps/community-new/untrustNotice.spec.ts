import {formatUntrustNotice} from "../../../src/apps/community-new/logic";

const GROUP_A = "0x1000000000000000000000000000000000000001";
const GROUP_B = "0x1000000000000000000000000000000000000002";
const ALICE = "0x2000000000000000000000000000000000000001";
const BOB = "0x2000000000000000000000000000000000000002";
const CAROL = "0x2000000000000000000000000000000000000003";

const base = {
  untrustedByGroup: {} as Record<string, string[]>,
  leftByGroup: {} as Record<string, string[]>,
  ineligible: [] as any[],
  untrustTxHashes: [] as string[]
};

describe("formatUntrustNotice", () => {
  it("returns null when no untrust transaction was sent", () => {
    expect(formatUntrustNotice(base)).toBeNull();
  });

  it("returns null in dry run, where untrusts are planned but no transaction is sent", () => {
    expect(formatUntrustNotice({...base, untrustedByGroup: {[GROUP_A]: [ALICE]}})).toBeNull();
  });

  it("lists every untrusted address per group with the reason, and the transactions", () => {
    const notice = formatUntrustNotice({
      untrustedByGroup: {[GROUP_A]: [ALICE, BOB], [GROUP_B]: [CAROL], "0x1000000000000000000000000000000000000003": []},
      leftByGroup: {[GROUP_A]: [ALICE]},
      ineligible: [
        {
          groupAddress: GROUP_A,
          avatarAddress: BOB,
          reasons: ["reputation", "fee-cap"],
          reputationScore: 10,
          requiredMinRepScore: 50,
          totalFeePercentage: 120
        }
      ],
      untrustTxHashes: ["0xaaa", "0xbbb"]
    });

    expect(notice).toBe(
      [
        "*community-new untrusted 3 address(es)*",
        `Group ${GROUP_A}:`,
        `• ${ALICE} (not on the wishlist)`,
        `• ${BOB} (ineligible: reputation, fee-cap)`,
        `Group ${GROUP_B}:`,
        `• ${CAROL} (ineligible)`,
        "Tx: 0xaaa, 0xbbb"
      ].join("\n")
    );
  });
});
