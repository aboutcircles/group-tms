import {getAddress} from "ethers";

import {
  buildRegisterHumanSubscriptionRequest,
  buildRegisterHumanCatchUpFilter,
  deriveRegisterHumanWsUrl,
  extractRegisterHumanEventsFromSubscriptionPayload,
  extractRegisterHumanAvatarsFromSubscriptionResult,
  extractRegisterHumanEventsFromQueryResponse
} from "../../../src/apps/router-tms/realtime";

describe("router-tms realtime helpers", () => {
  it("derives the default websocket endpoint from the HTTP RPC URL", () => {
    expect(deriveRegisterHumanWsUrl("https://rpc.aboutcircles.com/")).toBe("wss://rpc.aboutcircles.com/ws");
    expect(deriveRegisterHumanWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/ws");
    expect(deriveRegisterHumanWsUrl("wss://rpc.aboutcircles.com/ws/subscribe")).toBe("wss://rpc.aboutcircles.com/ws/subscribe");
  });

  it("uses logs subscriptions for chain websocket endpoints", () => {
    expect(buildRegisterHumanSubscriptionRequest("wss://rpc.aboutcircles.com/ws/chain")).toEqual({
      description: "chain logs",
      params: ["logs", {
        topics: ["0xfea7c1e1973c8be64c654eb06dc19ffbfc2e924d57544b9da0c0a27d3f893d77"]
      }]
    });

    expect(buildRegisterHumanSubscriptionRequest("wss://rpc.aboutcircles.com/ws")).toEqual({
      description: "Circles events",
      params: ["circles", "{}"]
    });
  });

  it("extracts newly registered human avatars from Circles subscription payloads", () => {
    const avatar = getAddress("0x2000000000000000000000000000000000000ABC").toLowerCase();
    const human = getAddress("0x2000000000000000000000000000000000000ABD").toLowerCase();

    const avatars = extractRegisterHumanAvatarsFromSubscriptionResult([
      {
        event: "CrcV2_RegisterHuman",
        values: {
          avatar,
          blockNumber: "0x1",
          transactionIndex: "0x0",
          logIndex: "0x0"
        }
      },
      {
        event: "RegisterHuman",
        values: {
          human,
          blockNumber: "0x2",
          transactionIndex: "0x0",
          logIndex: "0x0"
        }
      },
      {
        event: "CrcV2_RegisterGroup",
        values: {
          avatar,
          blockNumber: "0x3",
          transactionIndex: "0x0",
          logIndex: "0x0"
        }
      },
      {
        event: "CrcV2_RegisterHuman",
        values: {
          avatar,
          blockNumber: "0x4",
          transactionIndex: "0x0",
          logIndex: "0x0"
        }
      }
    ]);

    expect(avatars).toEqual([avatar, human]);
  });

  it("extracts newly registered human avatars from chain log subscription payloads", () => {
    const avatar = getAddress("0xe3493994e60f87e680f627297c21fcdeae28150b").toLowerCase();
    const events = extractRegisterHumanEventsFromSubscriptionPayload({
      address: "0xc12c1e50abb450d6205ea2c3fa861b3b834d13e8",
      blockNumber: "0x2b8b598",
      transactionIndex: "0x1d",
      logIndex: "0x7c",
      data: "0x",
      topics: [
        "0xfea7c1e1973c8be64c654eb06dc19ffbfc2e924d57544b9da0c0a27d3f893d77",
        "0x000000000000000000000000e3493994e60f87e680f627297c21fcdeae28150b",
        "0x0000000000000000000000008bdc8f71e02a016e6006d4e640b70a79f9b92437"
      ]
    });

    expect(events).toEqual([
      {
        avatar,
        cursor: {
          blockNumber: 45659544,
          transactionIndex: 29,
          logIndex: 124
        }
      }
    ]);
  });

  it("builds a composite catch-up filter from the last seen event cursor", () => {
    const filter = buildRegisterHumanCatchUpFilter(
      {blockNumber: 42, transactionIndex: 7, logIndex: 3},
      99
    );

    expect(filter).toEqual({
      Type: "Conjunction",
      ConjunctionType: "And",
      Predicates: [
        {
          Type: "Conjunction",
          ConjunctionType: "Or",
          Predicates: [
            {Type: "FilterPredicate", FilterType: "GreaterThan", Column: "blockNumber", Value: 42},
            {
              Type: "Conjunction",
              ConjunctionType: "And",
              Predicates: [
                {Type: "FilterPredicate", FilterType: "Equals", Column: "blockNumber", Value: 42},
                {Type: "FilterPredicate", FilterType: "GreaterThan", Column: "transactionIndex", Value: 7}
              ]
            },
            {
              Type: "Conjunction",
              ConjunctionType: "And",
              Predicates: [
                {Type: "FilterPredicate", FilterType: "Equals", Column: "blockNumber", Value: 42},
                {Type: "FilterPredicate", FilterType: "Equals", Column: "transactionIndex", Value: 7},
                {Type: "FilterPredicate", FilterType: "GreaterThan", Column: "logIndex", Value: 3}
              ]
            }
          ]
        },
        {Type: "FilterPredicate", FilterType: "LessThanOrEquals", Column: "blockNumber", Value: 99}
      ]
    });
  });

  it("parses RegisterHuman catch-up query rows into normalized avatars and cursors", () => {
    const avatar = getAddress("0x2000000000000000000000000000000000000ACE").toLowerCase();
    const events = extractRegisterHumanEventsFromQueryResponse({
      columns: ["avatar", "blockNumber", "transactionIndex", "logIndex"],
      rows: [
        [avatar, 50, 2, 1],
        ["bad-address", 50, 2, 2],
        [avatar, 50, 2, 1]
      ]
    });

    expect(events).toEqual([
      {
        avatar,
        cursor: {
          blockNumber: 50,
          transactionIndex: 2,
          logIndex: 1
        }
      }
    ]);
  });
});
