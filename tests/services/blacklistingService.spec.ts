import {BlacklistingService} from "../../src/services/blacklistingService";

const SERVICE_URL = "https://blacklist.example.invalid/api/blacklist";
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function mockFetchOk(addresses: string[]) {
  const fn = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({status: "ok", total: addresses.length, count: addresses.length, v2_only: true, addresses}),
  });
  global.fetch = fn as typeof fetch;
  return fn;
}

describe("BlacklistingService", () => {
  // --- The silent failure mode: checkBlacklist before load returns all-allowed ---
  describe("checkBlacklist before loadBlacklist", () => {
    it("returns all addresses as allowed (is_bot: false) — silent pass-through", async () => {
      const svc = new BlacklistingService(SERVICE_URL);
      const verdicts = await svc.checkBlacklist(["0xABC", "0xDEF"]);
      expect(verdicts).toEqual([
        {address: "0xABC", is_bot: false},
        {address: "0xDEF", is_bot: false},
      ]);
    });

    it("getBlacklistCount is 0 before load", () => {
      const svc = new BlacklistingService(SERVICE_URL);
      expect(svc.getBlacklistCount()).toBe(0);
    });
  });

  describe("loadBlacklist", () => {
    it("normalizes addresses to lowercase", async () => {
      mockFetchOk(["0xAaBbCcDd"]);
      const svc = new BlacklistingService(SERVICE_URL);
      await svc.loadBlacklist();

      const verdicts = await svc.checkBlacklist(["0xaabbccdd"]);
      expect(verdicts[0].is_bot).toBe(true);
    });

    it("skips non-string entries in addresses array without crashing", async () => {
      // API could return garbage — does the service survive?
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: "ok", total: 3, count: 3, v2_only: true,
          addresses: ["0xreal", 42, null, undefined, "0xalso_real"],
        }),
      }) as typeof fetch;

      const svc = new BlacklistingService(SERVICE_URL);
      await svc.loadBlacklist();
      expect(svc.getBlacklistCount()).toBe(2);
    });

    it("double-load replaces previous set (clear works)", async () => {
      mockFetchOk(["0xfirst"]);
      const svc = new BlacklistingService(SERVICE_URL);
      await svc.loadBlacklist();
      expect(svc.getBlacklistCount()).toBe(1);

      mockFetchOk(["0xsecond", "0xthird"]);
      await svc.loadBlacklist();
      expect(svc.getBlacklistCount()).toBe(2);
      // old entry gone
      const verdicts = await svc.checkBlacklist(["0xfirst"]);
      expect(verdicts[0].is_bot).toBe(false);
    });

    it("HTTP error throws and does NOT set loaded=true", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 500, statusText: "Internal Server Error",
      }) as typeof fetch;

      const svc = new BlacklistingService(SERVICE_URL);
      await expect(svc.loadBlacklist()).rejects.toThrow(/HTTP 500/);

      // Critical: checkBlacklist should still return all-allowed (not loaded)
      const verdicts = await svc.checkBlacklist(["0xtest"]);
      expect(verdicts[0].is_bot).toBe(false);
    });

    it("malformed response (no addresses array) throws", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({status: "ok", total: 0}), // missing addresses
      }) as typeof fetch;

      const svc = new BlacklistingService(SERVICE_URL);
      await expect(svc.loadBlacklist()).rejects.toThrow(/malformed/);
    });

    it("timeout wraps as descriptive error", async () => {
      const abortError = new DOMException("The operation was aborted", "AbortError");
      global.fetch = jest.fn().mockRejectedValue(abortError) as typeof fetch;

      const svc = new BlacklistingService(SERVICE_URL, 100);
      await expect(svc.loadBlacklist()).rejects.toThrow(/timed out/);
    });
  });

  describe("checkBlacklist case-insensitivity", () => {
    it("matches regardless of input case", async () => {
      mockFetchOk(["0xDeAdBeEf"]);
      const svc = new BlacklistingService(SERVICE_URL);
      await svc.loadBlacklist();

      const verdicts = await svc.checkBlacklist(["0xDEADBEEF", "0xdeadbeef", "0xDeAdBeEf"]);
      expect(verdicts.every(v => v.is_bot)).toBe(true);
    });

    it("non-blacklisted address gets category: undefined", async () => {
      mockFetchOk(["0xbad"]);
      const svc = new BlacklistingService(SERVICE_URL);
      await svc.loadBlacklist();

      const verdicts = await svc.checkBlacklist(["0xgood"]);
      expect(verdicts[0]).toEqual({address: "0xgood", is_bot: false, category: undefined});
    });

    it("empty addresses array returns empty verdicts", async () => {
      mockFetchOk(["0xbad"]);
      const svc = new BlacklistingService(SERVICE_URL);
      await svc.loadBlacklist();

      const verdicts = await svc.checkBlacklist([]);
      expect(verdicts).toEqual([]);
    });
  });
});
