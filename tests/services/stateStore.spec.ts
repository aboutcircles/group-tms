import { StateStore } from "../../src/services/stateStore";

// Mock the pg module
jest.mock("pg", () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  const mockPool = {
    connect: jest.fn().mockResolvedValue(mockClient),
    query: jest.fn(),
    end: jest.fn(),
  };
  return { Pool: jest.fn(() => mockPool) };
});

import pg from "pg";

function getMockPool(): any {
  return (pg.Pool as any).mock.results[0]?.value;
}

describe("StateStore", () => {
  let store: StateStore;
  let mockPool: any;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new StateStore("postgres://localhost/test");
    mockPool = getMockPool();
  });

  afterEach(async () => {
    await store.close();
  });

  describe("load", () => {
    it("returns null when no row exists", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await store.load("crc-backers");
      expect(result).toBeNull();
    });

    it("returns persisted state when row exists", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ last_scanned_block: "12345", state_data: { foo: "bar" } }],
      });
      const result = await store.load("crc-backers");
      expect(result).toEqual({ lastScannedBlock: 12345, data: { foo: "bar" } });
    });

    it("returns null and logs warning on PG error (graceful fallback)", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockPool.query.mockRejectedValueOnce(new Error("connection refused"));
      const result = await store.load("crc-backers");
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[state-store]"),
        expect.stringContaining("connection refused")
      );
    });
  });

  describe("save", () => {
    it("calls UPSERT with correct parameters", async () => {
      mockPool.query.mockResolvedValueOnce({});
      await store.save("oic", 99999);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO group_tms_state"),
        ["oic", 99999, null]
      );
    });

    it("passes state_data as JSON when provided", async () => {
      mockPool.query.mockResolvedValueOnce({});
      await store.save("oic", 100, { extra: "data" });
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO group_tms_state"),
        ["oic", 100, '{"extra":"data"}']
      );
    });

    it("logs warning on PG error (graceful fallback)", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockPool.query.mockRejectedValueOnce(new Error("disk full"));
      await store.save("oic", 100); // should not throw
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[state-store]"),
        expect.stringContaining("disk full")
      );
    });
  });
});
