import {__testables} from "../../src/services/circlesRpcService";

const {unwrapEventsResult} = __testables;

describe("circlesRpcService unwrapEventsResult", () => {
  it("parses array-shaped circles_events result", () => {
    const result = [
      {
        event: "CrcV2_CirclesBackingCompleted",
        values: {
          blockNumber: "0x10",
          timestamp: "0x20",
          transactionIndex: "0x1",
          logIndex: "0x2",
          backer: "0xabc"
        }
      }
    ];

    const parsed = unwrapEventsResult(result) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].$event).toBe("CrcV2_CirclesBackingCompleted");
    expect(parsed[0].blockNumber).toBe(16);
    expect(parsed[0].timestamp).toBe(32);
    expect(parsed[0].transactionIndex).toBe(1);
    expect(parsed[0].logIndex).toBe(2);
    expect(parsed[0].backer).toBe("0xabc");
  });

  it("parses object-shaped circles_events result with events[]", () => {
    const result = {
      events: [
        {
          event: "CrcV2_CirclesBackingInitiated",
          values: {
            blockNumber: "0x11",
            timestamp: "0x21",
            transactionIndex: "0x2",
            logIndex: "0x3",
            backer: "0xdef"
          }
        }
      ]
    };

    const parsed = unwrapEventsResult(result) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].$event).toBe("CrcV2_CirclesBackingInitiated");
    expect(parsed[0].blockNumber).toBe(17);
    expect(parsed[0].timestamp).toBe(33);
    expect(parsed[0].transactionIndex).toBe(2);
    expect(parsed[0].logIndex).toBe(3);
    expect(parsed[0].backer).toBe("0xdef");
  });
});
