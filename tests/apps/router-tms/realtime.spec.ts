import {getAddress} from "ethers";

import {
  buildRegisterHumanCatchUpFilter,
  deriveRegisterHumanWsUrl,
  extractRegisterHumanAvatarsFromSubscriptionResult,
  extractRegisterHumanEventsFromQueryResponse
} from "../../../src/apps/router-tms/realtime";

describe("router-tms realtime helpers", () => {
  it("derives the default websocket endpoint from the HTTP RPC URL", () => {
    expect(deriveRegisterHumanWsUrl("https://rpc.aboutcircles.com/")).toBe("wss://rpc.aboutcircles.com/ws");
    expect(deriveRegisterHumanWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/ws");
    expect(deriveRegisterHumanWsUrl("wss://rpc.aboutcircles.com/ws/subscribe")).toBe("wss://rpc.aboutcircles.com/ws/subscribe");
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
