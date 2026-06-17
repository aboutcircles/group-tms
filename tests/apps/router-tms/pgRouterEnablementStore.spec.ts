import {PgRouterEnablementStore} from "../../../src/apps/router-tms/pgRouterEnablementStore";
import {GROUP_TMS_DDL_LOCK_KEY} from "../../../src/services/stateStore";

// Mock the pg module — mirrors tests/services/stateStore.spec.ts shape.
jest.mock("pg", () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn()
  };
  const mockPool = {
    connect: jest.fn().mockResolvedValue(mockClient),
    query: jest.fn(),
    end: jest.fn()
  };
  return {Pool: jest.fn(() => mockPool)};
});

import pg from "pg";

// The pg mock returns one shared pool instance for every `new Pool()`, so
// calling the mocked constructor hands back that same singleton — letting us
// stage the constructor's first query (the existence probe) before building
// the store.
const getMockPool = (): any => (pg.Pool as any)();

const QUARANTINE_TTL_MS = 60 * 60 * 1000;

// All-lowercase test addresses — getAddress accepts these and checksums
// them; normalize then lowercases back. Mixed-case would have to satisfy
// EIP-55 checksum or getAddress throws.
const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDR_A_LC = ADDR_A;
const ADDR_B_LC = ADDR_B;

describe("PgRouterEnablementStore", () => {
  let store: PgRouterEnablementStore;
  let mockPool: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPool = getMockPool();
    // Stage the constructor's to_regclass probe as "table absent" so ensureTable
    // takes the locked create path these tests assert against — and crucially
    // without the probe throwing, which would route through its catch +
    // console.warn and pollute routine test setup.
    mockPool.query.mockResolvedValueOnce({rows: [{reg: null}]});
    store = new PgRouterEnablementStore("postgres://localhost/test", QUARANTINE_TTL_MS);
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
      // Trigger ready by issuing any query
      mockPool.query.mockResolvedValueOnce({rows: []});
      await store.loadEnablementStatuses();
      const mockClient = await mockPool.connect.mock.results[0].value;
      const calls = mockClient.query.mock.calls;
      expect(calls[0]).toEqual(["BEGIN"]);
      expect(calls[1]).toEqual([
        "SELECT pg_advisory_xact_lock($1)",
        [GROUP_TMS_DDL_LOCK_KEY]
      ]);
      expect(calls[2][0]).toMatch(/CREATE TABLE IF NOT EXISTS public\.router_tms_enablement/);
      expect(calls[3]).toEqual(["COMMIT"]);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("skips the advisory lock + DDL when the table already exists", async () => {
      // A boot whose existence probe finds the table present must NOT open a
      // transaction or take pg_advisory_xact_lock — the hot path that keeps a
      // near-idle shared state DB off the slow-query radar.
      jest.clearAllMocks();
      mockPool.query.mockResolvedValueOnce({rows: [{reg: "public.router_tms_enablement"}]});
      const warm = new PgRouterEnablementStore("postgres://localhost/test", QUARANTINE_TTL_MS);
      await (warm as any).ready;
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT to_regclass('public.router_tms_enablement') AS reg"
      );
      expect(mockPool.connect).not.toHaveBeenCalled();
      await warm.close();
    });
  });

  describe("markEnabled", () => {
    it("UPSERTs fallback_enabled with sticky-OR semantics", async () => {
      mockPool.query.mockResolvedValueOnce({});
      await store.markEnabled([ADDR_A, ADDR_B], "fallback");
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("fallback_enabled = router_tms_enablement.fallback_enabled OR EXCLUDED.fallback_enabled"),
        [[ADDR_A_LC, ADDR_B_LC]]
      );
    });

    it("UPSERTs base_group_enabled with sticky-OR semantics", async () => {
      mockPool.query.mockResolvedValueOnce({});
      await store.markEnabled([ADDR_A], "base-group");
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("base_group_enabled = router_tms_enablement.base_group_enabled OR EXCLUDED.base_group_enabled"),
        [[ADDR_A_LC]]
      );
    });

    it("no-op for empty addresses (no query issued)", async () => {
      await store.markEnabled([], "fallback");
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it("filters invalid addresses; valid subset still upserts", async () => {
      mockPool.query.mockResolvedValueOnce({});
      await store.markEnabled([ADDR_A, "not-an-address"], "fallback");
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        [[ADDR_A_LC]] // invalid filtered out
      );
    });

    it("filters invalid addresses; all invalid → no query issued", async () => {
      await store.markEnabled(["not-an-address", ""], "fallback");
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it("logs warning on PG error (graceful fallback)", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockPool.query.mockRejectedValueOnce(new Error("connection refused"));
      await store.markEnabled([ADDR_A], "fallback"); // must not throw
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[router-enablement-store]"),
        expect.stringContaining("connection refused")
      );
    });
  });

  describe("loadEnablementStatuses", () => {
    it("returns mapped rows for avatars with either flag set", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {avatar: ADDR_A_LC, fallback_enabled: true, base_group_enabled: false},
          {avatar: ADDR_B_LC, fallback_enabled: false, base_group_enabled: true}
        ]
      });
      const result = await store.loadEnablementStatuses();
      expect(result).toEqual([
        {avatar: ADDR_A_LC, fallbackEnabled: true, baseGroupEnabled: false},
        {avatar: ADDR_B_LC, fallbackEnabled: false, baseGroupEnabled: true}
      ]);
    });

    it("returns empty array and logs warning on PG error", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockPool.query.mockRejectedValueOnce(new Error("connection refused"));
      const result = await store.loadEnablementStatuses();
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[router-enablement-store]"),
        expect.stringContaining("connection refused")
      );
    });
  });

  describe("markQuarantined", () => {
    it("UPSERTs quarantined_until with TTL-derived timestamp", async () => {
      mockPool.query.mockResolvedValueOnce({});
      await store.markQuarantined([ADDR_A]);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("quarantined_until = EXCLUDED.quarantined_until"),
        [
          [ADDR_A_LC],
          expect.stringMatching(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        ]
      );
    });

    it("no-op for empty addresses", async () => {
      await store.markQuarantined([]);
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe("loadQuarantinedAddresses", () => {
    it("returns only un-expired quarantined avatars", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{avatar: ADDR_A_LC}, {avatar: ADDR_B_LC}]
      });
      const result = await store.loadQuarantinedAddresses();
      expect(result).toEqual([ADDR_A_LC, ADDR_B_LC]);
      // The WHERE clause must exclude expired rows
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("quarantined_until > now()")
      );
    });

    it("returns empty array on PG error (graceful fallback)", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockPool.query.mockRejectedValueOnce(new Error("connection refused"));
      const result = await store.loadQuarantinedAddresses();
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
