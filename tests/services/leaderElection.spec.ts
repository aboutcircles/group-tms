import {getEffectiveDryRun, LeaderElection} from "../../src/services/leaderElection";
import {GROUP_TMS_DDL_LOCK_KEY} from "../../src/services/stateStore";
import {FakeLogger} from "../../fakes/fakes";

// --- Mock pg ---
const mockQuery = jest.fn();
const mockEnd = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: mockConnect,
    end: mockEnd,
  })),
}));

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

describe("LeaderElection", () => {
  let statusUpdates: boolean[];
  let slackMessages: string[];
  let logger: FakeLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    statusUpdates = [];
    slackMessages = [];
    logger = new FakeLogger(true);
    // Default: pool.query (tryAcquire/stop) and client.query (ensureTable
    // BEGIN + lock + DDL + COMMIT) both succeed quietly.
    mockQuery.mockResolvedValue({rows: [], rowCount: 0});
    mockClientQuery.mockResolvedValue(undefined);
    mockClientRelease.mockReturnValue(undefined);
    mockConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
    mockEnd.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createLE(instanceId = "host-1") {
    return new LeaderElection(
      "postgres://test",
      instanceId,
      logger,
      {notifySlackStartOrCrash: async (msg: string) => { slackMessages.push(msg); }},
      (isLeader: boolean) => { statusUpdates.push(isLeader); }
    );
  }

  describe("tryAcquire", () => {
    it("acquires leadership when UPSERT returns a row", async () => {
      mockQuery.mockResolvedValueOnce({rows: [{instance_id: "host-1"}], rowCount: 1}); // UPSERT

      const le = createLE();
      await le.start();

      expect(le.isLeader).toBe(true);
      expect(statusUpdates).toContain(true);
      expect(slackMessages.some(m => m.includes("Acquired"))).toBe(true);

      await le.stop();
    });

    it("does NOT acquire when UPSERT returns 0 rows (another leader holds it)", async () => {
      mockQuery.mockResolvedValueOnce({rows: [], rowCount: 0});  // UPSERT — no match

      const le = createLE();
      await le.start();

      expect(le.isLeader).toBe(false);
      expect(statusUpdates).toContain(false);

      await le.stop();
    });

    it("rowCount: null treated as non-leader (edge case from pg driver)", async () => {
      // pg can return rowCount: null for certain statements
      mockQuery.mockResolvedValueOnce({rows: [], rowCount: null});

      const le = createLE();
      await le.start();

      expect(le.isLeader).toBe(false);
      await le.stop();
    });

    it("PG error during tryAcquire → falls back to non-leader (safe)", async () => {
      mockQuery.mockRejectedValueOnce(new Error("connection refused")); // tryAcquire fails

      const le = createLE();
      await le.start();

      expect(le.isLeader).toBe(false);
      expect(logger.logs).toContainEqual({
        level: "error",
        args: [
          expect.stringContaining("PG error"),
          expect.stringContaining("connection refused")
        ]
      });
      await le.stop();
    });

    it("detects leadership loss on subsequent heartbeat", async () => {
      mockQuery.mockResolvedValueOnce({rows: [{instance_id: "host-1"}], rowCount: 1}); // acquire

      const le = createLE();
      await le.start();
      expect(le.isLeader).toBe(true);

      // Next heartbeat: another host took over
      mockQuery.mockResolvedValueOnce({rows: [], rowCount: 0});
      jest.advanceTimersByTime(15_000);
      // Wait for the async tryAcquire to resolve
      await jest.advanceTimersByTimeAsync(0);

      expect(le.isLeader).toBe(false);
      expect(slackMessages.some(m => m.includes("Lost"))).toBe(true);

      await le.stop();
    });

    it("re-acquires on heartbeat (same instance, stays leader)", async () => {
      mockQuery
        .mockResolvedValueOnce({rows: [{instance_id: "host-1"}], rowCount: 1}) // acquire
        .mockResolvedValueOnce({rows: [{instance_id: "host-1"}], rowCount: 1}); // heartbeat

      const le = createLE();
      await le.start();
      expect(le.isLeader).toBe(true);
      statusUpdates.length = 0; // reset
      slackMessages.length = 0;

      jest.advanceTimersByTime(15_000);
      await jest.advanceTimersByTimeAsync(0);

      expect(le.isLeader).toBe(true);
      // No "Acquired" or "Lost" Slack message for steady-state
      expect(slackMessages).toHaveLength(0);

      await le.stop();
    });
  });

  describe("stop", () => {
    it("releases leadership by backdating heartbeat", async () => {
      mockQuery.mockResolvedValueOnce({rows: [{instance_id: "host-1"}], rowCount: 1});

      const le = createLE();
      await le.start();
      expect(le.isLeader).toBe(true);

      mockQuery.mockResolvedValueOnce({rows: [], rowCount: 1}); // UPDATE
      await le.stop();

      expect(le.isLeader).toBe(false);
      // Check the standalone UPDATE (not the UPSERT which also contains "UPDATE")
      const updateCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].trimStart().startsWith("UPDATE")
      );
      expect(updateCall).toBeDefined();
      // stop() passes [STALENESS_THRESHOLD_SEC + 1, instanceId]
      expect(updateCall![1][0]).toBe(46); // STALENESS_THRESHOLD_SEC + 1
      expect(updateCall![1][1]).toBe("host-1");
    });

    it("stop when not leader → skips UPDATE, just cleans up", async () => {
      mockQuery.mockResolvedValueOnce({rows: [], rowCount: 0}); // not leader

      const le = createLE();
      await le.start();
      expect(le.isLeader).toBe(false);

      await le.stop();

      // No standalone UPDATE call (the UPSERT contains "UPDATE" but it's inside INSERT..ON CONFLICT)
      const updateCalls = mockQuery.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].trimStart().startsWith("UPDATE")
      );
      expect(updateCalls).toHaveLength(0);
      expect(mockEnd).toHaveBeenCalled();
    });

    it("PG error during stop release → warns but doesn't throw", async () => {
      mockQuery.mockResolvedValueOnce({rows: [{instance_id: "host-1"}], rowCount: 1});

      const le = createLE();
      await le.start();

      mockQuery.mockRejectedValueOnce(new Error("pg gone"));
      await le.stop(); // should not throw

      expect(logger.logs).toContainEqual({
        level: "warn",
        args: [
          expect.stringContaining("Failed to release"),
          expect.stringContaining("pg gone")
        ]
      });
    });
  });

  describe("LeaderElection.create", () => {
    it("returns null when dbUrl is missing", async () => {
      const result = await LeaderElection.create(undefined, "host-1", logger);
      expect(result).toBeNull();
    });

    it("returns null when instanceId is missing", async () => {
      const result = await LeaderElection.create("postgres://test", undefined, logger);
      expect(result).toBeNull();
    });

    it("returns null when both are missing", async () => {
      const result = await LeaderElection.create(undefined, undefined, logger);
      expect(result).toBeNull();
    });

    it("returns null when logger is missing", async () => {
      const result = await LeaderElection.create("postgres://test", "host-1");
      expect(result).toBeNull();
    });
  });

  describe("ensureTable", () => {
    it("runs DDL inside BEGIN + pg_advisory_xact_lock + COMMIT", async () => {
      const le = createLE();
      await le.start();

      // mockClientQuery captures the ensureTable transaction sequence
      const calls = mockClientQuery.mock.calls.map((c: any[]) => c);
      expect(calls[0]).toEqual(["BEGIN"]);
      expect(calls[1]).toEqual([
        "SELECT pg_advisory_xact_lock($1)",
        [GROUP_TMS_DDL_LOCK_KEY],
      ]);
      expect(calls[2][0]).toMatch(/CREATE TABLE IF NOT EXISTS group_tms_leader/);
      expect(calls[3]).toEqual(["COMMIT"]);
      expect(mockClientRelease).toHaveBeenCalled();

      await le.stop();
    });
  });

  describe("onStatusUpdate callback", () => {
    it("fires on every tryAcquire, not just state changes", async () => {
      mockQuery
        .mockResolvedValueOnce({rows: [], rowCount: 0})  // tryAcquire: not leader
        .mockResolvedValueOnce({rows: [], rowCount: 0}); // heartbeat: still not leader

      const le = createLE();
      await le.start();

      jest.advanceTimersByTime(15_000);
      await jest.advanceTimersByTimeAsync(0);

      // Should fire twice: once on start, once on heartbeat
      expect(statusUpdates).toEqual([false, false]);

      await le.stop();
    });
  });
});
