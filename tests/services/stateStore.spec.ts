import { StateStore, GROUP_TMS_DDL_LOCK_KEY } from "../../src/services/stateStore";

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

// The pg mock returns one shared pool instance for every `new Pool()`, so
// calling the mocked constructor hands back that same singleton — letting us
// stage the constructor's first query (the existence probe) before building
// the store.
const getMockPool = (): any => (pg.Pool as any)();

describe("StateStore", () => {
  let store: StateStore;
  let mockPool: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPool = getMockPool();
    // Stage the constructor's to_regclass probe as "table absent" so ensureTable
    // takes the locked create path these tests assert against — and crucially
    // without the probe throwing, which would route through its catch +
    // console.warn and pollute routine test setup.
    mockPool.query.mockResolvedValueOnce({ rows: [{ reg: null }] });
    store = new StateStore("postgres://localhost/test");
    // Let ensureTable settle, then drop its pool.query calls so each test
    // asserts only the queries it triggers.
    await (store as any).ready;
    mockPool.query.mockClear();
  });

  afterEach(async () => {
    await store.close();
  });

  describe("ensureTable", () => {
    it("runs DDL inside BEGIN + pg_advisory_xact_lock + COMMIT", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // Trigger ready via any query
      await store.load("anything");
      const mockClient = await mockPool.connect.mock.results[0].value;
      const calls = mockClient.query.mock.calls;
      expect(calls[0]).toEqual(["BEGIN"]);
      expect(calls[1]).toEqual([
        "SELECT pg_advisory_xact_lock($1)",
        [GROUP_TMS_DDL_LOCK_KEY],
      ]);
      expect(calls[2][0]).toMatch(/CREATE TABLE IF NOT EXISTS public\.group_tms_state/);
      expect(calls[3]).toEqual(["COMMIT"]);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("skips the advisory lock + DDL when the table already exists", async () => {
      // A boot whose existence probe finds the table present must NOT open a
      // transaction or take pg_advisory_xact_lock — the hot path that keeps a
      // near-idle shared state DB off the slow-query radar.
      jest.clearAllMocks();
      mockPool.query.mockResolvedValueOnce({ rows: [{ reg: "public.group_tms_state" }] });
      const warm = new StateStore("postgres://localhost/test");
      await (warm as any).ready;
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT to_regclass('public.group_tms_state') AS reg"
      );
      expect(mockPool.connect).not.toHaveBeenCalled();
      await warm.close();
    });
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
