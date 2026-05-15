import {Interface} from "ethers";

import {
  AFFILIATE_GROUP_CHANGED_ABI,
  AFFILIATE_GROUP_CHANGED_TOPIC0,
  AffiliateGroupChangedWithCursor,
  buildAffiliateGroupChangedSubscriptionRequest,
  deriveGroupAffiliatesWsUrl,
  extractAffiliateGroupChangedEventsFromSubscriptionPayload,
  filterEventsAfterCursor
} from "../../../src/apps/group-affiliates/realtime";

const REGISTRY = "0xcA8222E780D046707083F51377B5Fd85E2866014";
const HUMAN = "0x1000000000000000000000000000000000000001";
const GROUP_A = "0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026";
const GROUP_B = "0xb629a1e86F3eFada0F87C83494Da8Cc34C3F84ef";
const UNMANAGED = "0x9999999999999999999999999999999999999999";
const iface = new Interface(AFFILIATE_GROUP_CHANGED_ABI);

function makeLog(
  human: string,
  oldGroup: string,
  newGroup: string,
  blockNumber: number,
  transactionIndex: number,
  logIndex: number,
  address = REGISTRY
) {
  const encoded = iface.encodeEventLog(
    iface.getEvent("AffiliateGroupChanged")!,
    [human, oldGroup, newGroup]
  );

  return {
    address,
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionIndex: `0x${transactionIndex.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: `0xtx${blockNumber}${transactionIndex}${logIndex}`,
    topics: encoded.topics,
    data: encoded.data
  };
}

describe("group-affiliates realtime helpers", () => {
  it("derives the default chain websocket URL from the HTTP RPC URL", () => {
    expect(deriveGroupAffiliatesWsUrl("https://rpc.aboutcircles.com/")).toBe("wss://rpc.aboutcircles.com/ws/chain");
    expect(deriveGroupAffiliatesWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/ws/chain");
    expect(deriveGroupAffiliatesWsUrl("wss://rpc.aboutcircles.com/ws/chain")).toBe("wss://rpc.aboutcircles.com/ws/chain");
  });

  it("builds a chain log subscription for the affiliate registry", () => {
    expect(buildAffiliateGroupChangedSubscriptionRequest(REGISTRY)).toEqual({
      description: "AffiliateGroupChanged chain logs",
      params: ["logs", {
        address: REGISTRY,
        topics: [AFFILIATE_GROUP_CHANGED_TOPIC0]
      }]
    });
  });

  it("extracts and orders AffiliateGroupChanged events from WSS log payloads", () => {
    const events = extractAffiliateGroupChangedEventsFromSubscriptionPayload([
      makeLog(HUMAN, GROUP_A, GROUP_B, 20, 2, 7),
      makeLog(HUMAN, UNMANAGED, GROUP_A, 20, 1, 8),
      makeLog(HUMAN, GROUP_B, UNMANAGED, 19, 9, 1)
    ], REGISTRY);

    expect(events.map((event) => event.cursor)).toEqual([
      {blockNumber: 19, transactionIndex: 9, logIndex: 1},
      {blockNumber: 20, transactionIndex: 1, logIndex: 8},
      {blockNumber: 20, transactionIndex: 2, logIndex: 7}
    ]);
    expect(events[0]).toMatchObject({
      human: HUMAN,
      oldGroup: GROUP_B,
      newGroup: UNMANAGED
    });
  });

  it("skips malformed logs and logs from a different registry", () => {
    const events = extractAffiliateGroupChangedEventsFromSubscriptionPayload([
      makeLog(HUMAN, UNMANAGED, GROUP_A, 10, 0, 0, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      {topics: ["0xnot-a-topic"], data: "0x"},
      {topics: [AFFILIATE_GROUP_CHANGED_TOPIC0], data: "0x"}
    ], REGISTRY);

    expect(events).toEqual([]);
  });

  it("filters catch-up results after the persisted cursor", () => {
    const before = eventAt(10, 0, 0);
    const same = eventAt(10, 1, 1);
    const after = eventAt(10, 1, 2);
    const later = eventAt(11, 0, 0);

    const events = filterEventsAfterCursor(
      [later, before, after, same],
      {blockNumber: 10, transactionIndex: 1, logIndex: 1}
    );

    expect(events).toEqual([after, later]);
  });
});

function eventAt(blockNumber: number, transactionIndex: number, logIndex: number): AffiliateGroupChangedWithCursor {
  return {
    blockNumber,
    txHash: `0x${blockNumber}${transactionIndex}${logIndex}`,
    human: HUMAN,
    oldGroup: UNMANAGED,
    newGroup: GROUP_A,
    cursor: {blockNumber, transactionIndex, logIndex}
  };
}
