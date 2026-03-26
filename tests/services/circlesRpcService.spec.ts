import { CirclesRpcService } from "../../src/services/circlesRpcService";

// ── Mock @aboutcircles/sdk-rpc ──────────────────────────────────────────────
const mockClientCall = jest.fn();
const mockGetAvatarInfo = jest.fn();
const mockGetAvatarInfoBatch = jest.fn();

function makeMockPagedQuery(pages: any[][]) {
  let pageIdx = -1;
  return {
    queryNextPage: jest.fn(async () => {
      pageIdx++;
      return pageIdx < pages.length;
    }),
    get currentPage() {
      return pageIdx >= 0 && pageIdx < pages.length
        ? { results: pages[pageIdx] }
        : undefined;
    },
  };
}

const mockGetTrustRelations = jest.fn();
const mockGetGroups = jest.fn();

let nextPagedQueryMock: ReturnType<typeof makeMockPagedQuery> | null = null;

jest.mock("@aboutcircles/sdk-rpc", () => ({
  CirclesRpc: jest.fn().mockImplementation(() => ({
    client: { call: mockClientCall },
    avatar: {
      getAvatarInfo: mockGetAvatarInfo,
      getAvatarInfoBatch: mockGetAvatarInfoBatch,
    },
    trust: { getTrustRelations: mockGetTrustRelations },
    group: { getGroups: mockGetGroups },
  })),
  PagedQuery: jest.fn().mockImplementation((_client: any, _opts: any) => {
    // fetchAllHumanAvatars creates its own PagedQuery
    if (nextPagedQueryMock) {
      const pq = nextPagedQueryMock;
      nextPagedQueryMock = null;
      return pq;
    }
    return makeMockPagedQuery([]);
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────
const FACTORY = "0xFACT0RY000000000000000000000000DeAdBeEf";
const RPC_URL = "https://rpc.example.com";

function buildService(): CirclesRpcService {
  return new CirclesRpcService(RPC_URL);
}

function makeRawBackingCompletedEvent(blockNumber: number, suffix: string) {
  const hex = (value: number) => `0x${value.toString(16)}`;
  return {
    event: "CrcV2_CirclesBackingCompleted",
    values: {
      blockNumber: hex(blockNumber),
      timestamp: hex(blockNumber + 1000),
      transactionIndex: "0x1",
      logIndex: "0x2",
      transactionHash: `0xtx${suffix}`,
      backer: `0xbacker${suffix}`,
      circlesBackingInstance: `0xinst${suffix}`,
      lbp: `0xlbp${suffix}`,
      emitter: FACTORY,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────
beforeEach(() => jest.clearAllMocks());

describe("CirclesRpcService", () => {
  // ────────────────────────────────────────────────────────────────────────
  // CRITICAL: backing event RPC param assertions
  // ────────────────────────────────────────────────────────────────────────
  describe("fetchBackingCompletedEvents", () => {
    it("passes address=undefined and emitter FilterPredicate (not factory as address)", async () => {
      mockClientCall.mockResolvedValueOnce({ events: [] });
      const svc = buildService();
      await svc.fetchBackingCompletedEvents(FACTORY, 100, 200);

      expect(mockClientCall).toHaveBeenCalledTimes(1);
      expect(mockClientCall).toHaveBeenCalledWith("circles_events", [
        undefined,
        100,
        200,
        ["CrcV2_CirclesBackingCompleted"],
        [{ Type: "FilterPredicate", FilterType: "Equals", Column: "emitter", Value: FACTORY }],
      ]);
    });

    it("passes toBlock=null when toBlock is omitted", async () => {
      mockClientCall
        .mockResolvedValueOnce("0x32")
        .mockResolvedValueOnce({ events: [] });
      const svc = buildService();
      await svc.fetchBackingCompletedEvents(FACTORY, 50);

      expect(mockClientCall.mock.calls[0]).toEqual(["eth_blockNumber", []]);
      const args = mockClientCall.mock.calls[1][1];
      expect(args[0]).toBeUndefined();   // address
      expect(args[2]).toBe(50);           // resolved head block
    });

    it("splits ranges when circles_events returns the capped result size", async () => {
      mockClientCall
        .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => makeRawBackingCompletedEvent(1000 - index, `cap${index}`)))
        .mockResolvedValueOnce([makeRawBackingCompletedEvent(12, "left")])
        .mockResolvedValueOnce([
          makeRawBackingCompletedEvent(18, "right-a"),
          makeRawBackingCompletedEvent(16, "right-b"),
        ]);

      const svc = buildService();
      const events = await svc.fetchBackingCompletedEvents(FACTORY, 10, 18);

      expect(mockClientCall).toHaveBeenCalledTimes(3);
      expect(mockClientCall.mock.calls[0]).toEqual(["circles_events", [
        undefined,
        10,
        18,
        ["CrcV2_CirclesBackingCompleted"],
        [{ Type: "FilterPredicate", FilterType: "Equals", Column: "emitter", Value: FACTORY }],
      ]]);
      expect(mockClientCall.mock.calls[1][1][1]).toBe(10);
      expect(mockClientCall.mock.calls[1][1][2]).toBe(14);
      expect(mockClientCall.mock.calls[2][1][1]).toBe(15);
      expect(mockClientCall.mock.calls[2][1][2]).toBe(18);
      expect(events.map((event) => event.blockNumber)).toEqual([18, 16, 12]);
    });
  });

  describe("fetchBackingInitiatedEvents", () => {
    it("passes address=undefined and emitter FilterPredicate", async () => {
      mockClientCall.mockResolvedValueOnce({ events: [] });
      const svc = buildService();
      await svc.fetchBackingInitiatedEvents(FACTORY, 300, 400);

      expect(mockClientCall).toHaveBeenCalledWith("circles_events", [
        undefined,
        300,
        400,
        ["CrcV2_CirclesBackingInitiated"],
        [{ Type: "FilterPredicate", FilterType: "Equals", Column: "emitter", Value: FACTORY }],
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Event transformation: hex → number parsing
  // ────────────────────────────────────────────────────────────────────────
  describe("event transformation", () => {
    it("parses events when circles_events returns a bare array", async () => {
      mockClientCall.mockResolvedValueOnce([
        {
          event: "CrcV2_CirclesBackingCompleted",
          values: {
            blockNumber: "0x1a3",
            timestamp: "0x2710",
            transactionIndex: "0xa",
            logIndex: "0x1f",
            transactionHash: "0xabc123",
            backer: "0xbacker",
            circlesBackingInstance: "0xinst",
            lbp: "0xlbp",
            emitter: "0xfactory",
          },
        },
      ]);

      const svc = buildService();
      const events = await svc.fetchBackingCompletedEvents(FACTORY, 1, 999);

      expect(events).toHaveLength(1);
      expect(events[0].blockNumber).toBe(419);
      expect(events[0].timestamp).toBe(10000);
      expect(events[0].backer).toBe("0xbacker");
      expect(events[0].circlesBackingInstance).toBe("0xinst");
      expect(events[0].lbp).toBe("0xlbp");
    });

    it("parses hex blockNumber/timestamp/transactionIndex/logIndex to numbers", async () => {
      mockClientCall.mockResolvedValueOnce({
        events: [
          {
            event: "CrcV2_CirclesBackingCompleted",
            values: {
              blockNumber: "0x1a3",
              timestamp: "0x2710",
              transactionIndex: "0xa",
              logIndex: "0x1f",
              transactionHash: "0xabc123",
              backer: "0xbacker",
              circlesBackingInstance: "0xinst",
              lbp: "0xlbp",
              emitter: "0xfactory",
            },
          },
        ],
      });

      const svc = buildService();
      const events = await svc.fetchBackingCompletedEvents(FACTORY, 1, 999);

      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev.blockNumber).toBe(419);         // 0x1a3
      expect(ev.timestamp).toBe(10000);          // 0x2710
      expect(ev.transactionIndex).toBe(10);      // 0xa
      expect(ev.logIndex).toBe(31);              // 0x1f
      expect(ev.transactionHash).toBe("0xabc123");
      expect(ev.backer).toBe("0xbacker");
      expect(ev.circlesBackingInstance).toBe("0xinst");
      expect(ev.lbp).toBe("0xlbp");
      expect(ev.emitter).toBe("0xfactory");
      expect(ev.$event).toBe("CrcV2_CirclesBackingCompleted");
    });

    it("handles already-numeric values gracefully", async () => {
      mockClientCall
        .mockResolvedValueOnce("0x64")
        .mockResolvedValueOnce({
          events: [
            {
              event: "CrcV2_CirclesBackingInitiated",
              values: {
                blockNumber: 500,
                timestamp: 12345,
                transactionIndex: 2,
                logIndex: 7,
                transactionHash: "0xdef",
                backer: "0xb",
                circlesBackingInstance: "0xi",
                emitter: "0xe",
              },
            },
          ],
        });

      const svc = buildService();
      const events = await svc.fetchBackingInitiatedEvents(FACTORY, 1);
      expect(events[0].blockNumber).toBe(500);
      expect(events[0].timestamp).toBe(12345);
    });

    it("returns empty array when response has no events", async () => {
      mockClientCall
        .mockResolvedValueOnce("0x64")
        .mockResolvedValueOnce({});
      const svc = buildService();
      const events = await svc.fetchBackingCompletedEvents(FACTORY, 1);
      expect(events).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Smoke tests for other methods
  // ────────────────────────────────────────────────────────────────────────
  describe("isHuman", () => {
    it("returns true when avatar is human", async () => {
      mockGetAvatarInfo.mockResolvedValueOnce({ isHuman: true });
      const svc = buildService();
      expect(await svc.isHuman("0x1234567890123456789012345678901234567890")).toBe(true);
    });

    it("returns false when avatar is not human", async () => {
      mockGetAvatarInfo.mockResolvedValueOnce({ isHuman: false });
      const svc = buildService();
      expect(await svc.isHuman("0x1234567890123456789012345678901234567890")).toBe(false);
    });

    it("returns false when info is null", async () => {
      mockGetAvatarInfo.mockResolvedValueOnce(null);
      const svc = buildService();
      expect(await svc.isHuman("0x1234567890123456789012345678901234567890")).toBe(false);
    });
  });

  describe("isHumanBatch", () => {
    it("returns map with human status for each address", async () => {
      const addr1 = "0x1111111111111111111111111111111111111111";
      const addr2 = "0x2222222222222222222222222222222222222222";
      mockGetAvatarInfoBatch.mockResolvedValueOnce([
        { avatar: addr1, isHuman: true },
        { avatar: addr2, isHuman: false },
      ]);

      const svc = buildService();
      const result = await svc.isHumanBatch([addr1, addr2]);
      expect(result.get(addr1.toLowerCase())).toBe(true);
      expect(result.get(addr2.toLowerCase())).toBe(false);
    });

    it("defaults missing addresses to false", async () => {
      const addr = "0x3333333333333333333333333333333333333333";
      mockGetAvatarInfoBatch.mockResolvedValueOnce([]);

      const svc = buildService();
      const result = await svc.isHumanBatch([addr]);
      expect(result.get(addr.toLowerCase())).toBe(false);
    });
  });

  describe("fetchAllTrustees", () => {
    it("collects trustees across multiple pages", async () => {
      const truster = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      mockGetTrustRelations.mockReturnValueOnce(
        makeMockPagedQuery([
          [
            { truster: truster.toLowerCase(), trustee: "0xbbb" },
            { truster: "0xother", trustee: "0xccc" }, // different truster, filtered out
          ],
          [{ truster: truster.toLowerCase(), trustee: "0xddd" }],
        ]),
      );

      const svc = buildService();
      const trustees = await svc.fetchAllTrustees(truster);
      expect(trustees).toEqual(["0xbbb", "0xddd"]);
    });
  });

  describe("fetchAllBaseGroups", () => {
    it("collects groups across pages and deduplicates", async () => {
      mockGetGroups.mockReturnValueOnce(
        makeMockPagedQuery([
          [{ group: "0xg1" }, { group: "0xg2" }],
          [{ group: "0xg1" }, { group: "0xg3" }], // 0xg1 duplicated
        ]),
      );

      const svc = buildService();
      const groups = await svc.fetchAllBaseGroups();
      expect(groups).toEqual(expect.arrayContaining(["0xg1", "0xg2", "0xg3"]));
      expect(groups).toHaveLength(3);
    });

    it("skips rows with empty or missing group field", async () => {
      mockGetGroups.mockReturnValueOnce(
        makeMockPagedQuery([
          [{ group: "" }, { group: "0xg1" }, {}],
        ]),
      );

      const svc = buildService();
      const groups = await svc.fetchAllBaseGroups();
      expect(groups).toEqual(["0xg1"]);
    });
  });

  describe("fetchAllHumanAvatars", () => {
    it("collects and checksums valid avatars across pages", async () => {
      // valid EIP-55 addresses (40 hex chars)
      const addr1 = "0x1111111111111111111111111111111111111111";
      const addr2 = "0x2222222222222222222222222222222222222222";
      nextPagedQueryMock = makeMockPagedQuery([
        [{ avatar: addr1 }],
        [{ avatar: addr2 }],
      ]);

      const svc = buildService();
      const avatars = await svc.fetchAllHumanAvatars();
      expect(avatars).toHaveLength(2);
      // getAddress normalizes then toLowerCase
      expect(avatars).toContain(addr1.toLowerCase());
      expect(avatars).toContain(addr2.toLowerCase());
    });

    it("silently skips invalid addresses", async () => {
      nextPagedQueryMock = makeMockPagedQuery([
        [
          { avatar: "0x1111111111111111111111111111111111111111" },
          { avatar: "not-an-address" },       // invalid
          { avatar: "" },                      // empty
        ],
      ]);

      const svc = buildService();
      const avatars = await svc.fetchAllHumanAvatars();
      expect(avatars).toHaveLength(1);
      expect(avatars[0]).toBe("0x1111111111111111111111111111111111111111");
    });

    it("skips null/undefined rows", async () => {
      nextPagedQueryMock = makeMockPagedQuery([
        [null, undefined, { avatar: "0x1111111111111111111111111111111111111111" }],
      ]);

      const svc = buildService();
      const avatars = await svc.fetchAllHumanAvatars();
      expect(avatars).toHaveLength(1);
    });

    it("returns empty array when no pages", async () => {
      nextPagedQueryMock = makeMockPagedQuery([]);

      const svc = buildService();
      const avatars = await svc.fetchAllHumanAvatars();
      expect(avatars).toEqual([]);
    });

    it("calls logger.info with page count when logger provided", async () => {
      nextPagedQueryMock = makeMockPagedQuery([
        [{ avatar: "0x1111111111111111111111111111111111111111" }],
      ]);
      const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

      const svc = buildService();
      await svc.fetchAllHumanAvatars(1000, mockLogger as any);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("1 avatars"),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("1 page(s)"),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Edge cases: multiple events in single response
  // ────────────────────────────────────────────────────────────────────────
  describe("backing events — multiple events in response", () => {
    it("transforms all events in a batch", async () => {
      mockClientCall.mockResolvedValueOnce({
        events: [
          {
            event: "CrcV2_CirclesBackingCompleted",
            values: { blockNumber: "0x1", timestamp: "0x2", transactionIndex: "0x3", logIndex: "0x4", transactionHash: "0xa", backer: "0xb1", circlesBackingInstance: "0xi1", lbp: "0xl1", emitter: "0xe" },
          },
          {
            event: "CrcV2_CirclesBackingCompleted",
            values: { blockNumber: "0x10", timestamp: "0x20", transactionIndex: "0x30", logIndex: "0x40", transactionHash: "0xb", backer: "0xb2", circlesBackingInstance: "0xi2", lbp: "0xl2", emitter: "0xe" },
          },
        ],
      });

      const svc = buildService();
      const events = await svc.fetchBackingCompletedEvents(FACTORY, 1, 999);
      expect(events).toHaveLength(2);
      expect(events[0].blockNumber).toBe(16); // 0x10
      expect(events[1].blockNumber).toBe(1);
      expect(events[0].backer).toBe("0xb2");
      expect(events[1].backer).toBe("0xb1");
    });
  });
});
