/**
 * Integration smoke tests against a live Circles RPC endpoint.
 *
 * These tests hit real infrastructure — they verify that our code's assumptions
 * about external APIs (SDK param ordering, response shapes, event schemas)
 * still hold. They catch the class of bugs that unit tests with mocks cannot:
 * contract drift, SDK breaking changes, and RPC endpoint behavior changes.
 *
 * Run manually:
 *   npm run test:integration
 *
 * Configure endpoint:
 *   INTEGRATION_RPC_URL=https://staging.circlesubi.network  (default)
 */
import {CirclesRpcService} from "../../src/services/circlesRpcService";
import {ChainRpcService} from "../../src/services/chainRpcService";
import {checkRpcHealth} from "../../src/services/rpcHealthService";
import {AffiliateGroupEventsService} from "../../src/services/affiliateGroupEventsService";
import {BackingInstanceService} from "../../src/services/backingInstanceService";
import {BlacklistingService} from "../../src/services/blacklistingService";

// ---------------------------------------------------------------------------
// Config — all from env or sensible defaults for Gnosis Chain
// ---------------------------------------------------------------------------
const RPC_URL = process.env.INTEGRATION_RPC_URL ?? "https://staging.circlesubi.network";
const BACKING_FACTORY = process.env.INTEGRATION_BACKING_FACTORY ?? "0xeced91232c609a42f6016860e8223b8aecaa7bd0";
const AFFILIATE_REGISTRY = process.env.INTEGRATION_AFFILIATE_REGISTRY ?? "0xca8222e780d046707083f51377b5fd85e2866014";
const OIC_GROUP = process.env.INTEGRATION_OIC_GROUP ?? "0x4E2564e5df6C1Fb10C1A018538de36E4D5844DE5";
const BLACKLIST_URL = process.env.INTEGRATION_BLACKLIST_URL ?? "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist";

// Known addresses on Gnosis Chain Circles v2 — adjust if they become stale
const KNOWN_HUMAN = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
const KNOWN_BACKING_INSTANCE = "0x18fcb7eab7d09fd221f29bccff09457a2db8e1e0";

const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function describeIntegration(name: string, fn: () => void) {
  const skip = process.env.SKIP_INTEGRATION === "1";
  (skip ? describe.skip : describe)(name, fn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describeIntegration("Integration: RPC Health", () => {
  it("checkRpcHealth returns healthy with a recent block number", async () => {
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(true);
    expect(result.blockNumber).toBeGreaterThan(30_000_000); // Gnosis is well past this
    expect(result.error).toBeUndefined();
  }, TIMEOUT_MS);
});

describeIntegration("Integration: ChainRpcService", () => {
  const chain = new ChainRpcService(RPC_URL);

  it("getHeadBlock returns a valid block with reasonable timestamp", async () => {
    const head = await chain.getHeadBlock();
    expect(head.blockNumber).toBeGreaterThan(30_000_000);
    // Timestamp should be within last 60 seconds (5s block time on Gnosis)
    const nowSec = Math.floor(Date.now() / 1000);
    expect(head.timestamp).toBeGreaterThan(nowSec - 120);
    expect(head.timestamp).toBeLessThanOrEqual(nowSec + 10);
  }, TIMEOUT_MS);
});

describeIntegration("Integration: CirclesRpcService", () => {
  const circles = new CirclesRpcService(RPC_URL);

  it("isHuman returns boolean for a known address", async () => {
    const result = await circles.isHuman(KNOWN_HUMAN);
    expect(typeof result).toBe("boolean");
  }, TIMEOUT_MS);

  it("isHumanBatch returns a map with entries for all requested addresses", async () => {
    const addrs = [KNOWN_HUMAN, "0x0000000000000000000000000000000000000001"];
    const result = await circles.isHumanBatch(addrs);
    expect(result.size).toBe(addrs.length);
    for (const addr of addrs) {
      expect(result.has(addr.toLowerCase())).toBe(true);
    }
  }, TIMEOUT_MS);

  it("fetchAllBaseGroups returns a non-empty array of addresses", async () => {
    const groups = await circles.fetchAllBaseGroups(10);
    expect(groups.length).toBeGreaterThan(0);
    // Each should look like an address
    for (const g of groups) {
      expect(g).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  }, TIMEOUT_MS);

  it("fetchAllTrustees returns an array (may be empty for some addresses)", async () => {
    // Use a known group that should have trustees
    const trustees = await circles.fetchAllTrustees(OIC_GROUP);
    expect(Array.isArray(trustees)).toBe(true);
    // At least some group should have trustees in prod
  }, TIMEOUT_MS);

  describe("circles_events (the SDK workaround path)", () => {
    it("fetchBackingInitiatedEvents returns valid event shapes", async () => {
      // Query a narrow recent range to keep it fast
      const chain = new ChainRpcService(RPC_URL);
      const head = await chain.getHeadBlock();
      // Look back ~2 hours (~1440 blocks at 5s) — may be empty, that's OK
      const fromBlock = head.blockNumber - 1440;

      const events = await circles.fetchBackingInitiatedEvents(BACKING_FACTORY, fromBlock);
      expect(Array.isArray(events)).toBe(true);

      // If there are events, validate their shape
      for (const e of events) {
        expect(typeof e.blockNumber).toBe("number");
        expect(e.blockNumber).toBeGreaterThan(0);
        expect(typeof e.backer).toBe("string");
        expect(typeof e.circlesBackingInstance).toBe("string");
        expect(e.transactionHash).toBeDefined();
      }
    }, TIMEOUT_MS);

    it("fetchBackingCompletedEvents returns valid event shapes", async () => {
      const chain = new ChainRpcService(RPC_URL);
      const head = await chain.getHeadBlock();
      const fromBlock = head.blockNumber - 1440;

      const events = await circles.fetchBackingCompletedEvents(BACKING_FACTORY, fromBlock);
      expect(Array.isArray(events)).toBe(true);

      for (const e of events) {
        expect(typeof e.blockNumber).toBe("number");
        expect(typeof e.backer).toBe("string");
        expect(typeof e.circlesBackingInstance).toBe("string");
        expect(typeof e.lbp).toBe("string");
      }
    }, TIMEOUT_MS);

    it("circles_events with future fromBlock returns empty array", async () => {
      const events = await circles.fetchBackingInitiatedEvents(BACKING_FACTORY, 999_999_999);
      expect(events).toEqual([]);
    }, TIMEOUT_MS);
  });
});

describeIntegration("Integration: BackingInstanceService", () => {
  const backing = new BackingInstanceService(RPC_URL);

  it("simulateCreateLbp returns a known result string for a real instance", async () => {
    const result = await backing.simulateCreateLbp(KNOWN_BACKING_INSTANCE);
    // Should be one of the defined result types — not throw
    expect([
      "LBPAlreadyCreated",
      "OrderNotYetFilled",
      "BackingAssetBalanceInsufficient",
      "Success",
    ]).toContain(result);
  }, TIMEOUT_MS);

  it("simulateResetCowSwapOrder returns a known result string", async () => {
    const result = await backing.simulateResetCowSwapOrder(KNOWN_BACKING_INSTANCE);
    expect([
      "OrderAlreadySettled",
      "OrderUidIsTheSame",
      "OrderValid",
    ]).toContain(result);
  }, TIMEOUT_MS);
});

describeIntegration("Integration: AffiliateGroupEventsService", () => {
  it("fetches events without error for a small block range", async () => {
    const chain = new ChainRpcService(RPC_URL);
    const head = await chain.getHeadBlock();
    const fromBlock = head.blockNumber - 500;

    const svc = new AffiliateGroupEventsService(RPC_URL);
    const events = await svc.fetchAffiliateGroupChanged(
      AFFILIATE_REGISTRY,
      OIC_GROUP,
      fromBlock,
      head.blockNumber,
    );
    expect(Array.isArray(events)).toBe(true);
    for (const e of events) {
      expect(typeof e.blockNumber).toBe("number");
      expect(typeof e.human).toBe("string");
      expect(typeof e.txHash).toBe("string");
    }
  }, TIMEOUT_MS);
});

describeIntegration("Integration: BlacklistingService", () => {
  it("loads blacklist and returns a non-zero count", async () => {
    const svc = new BlacklistingService(BLACKLIST_URL);
    await svc.loadBlacklist();
    expect(svc.getBlacklistCount()).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  it("checkBlacklist after load returns verdicts for all addresses", async () => {
    const svc = new BlacklistingService(BLACKLIST_URL);
    await svc.loadBlacklist();
    const verdicts = await svc.checkBlacklist(["0xdeadbeef", "0xABC"]);
    expect(verdicts).toHaveLength(2);
    for (const v of verdicts) {
      expect(typeof v.is_bot).toBe("boolean");
    }
  }, TIMEOUT_MS);
});
