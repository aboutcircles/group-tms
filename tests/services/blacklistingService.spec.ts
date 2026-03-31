import {BlacklistingService} from "../../src/services/blacklistingService";

const SERVICE_URL = "https://blacklist.example.invalid/api/blacklist";
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function mockFetchOk(addresses: string[], total?: number) {
  const fn = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({status: "ok", total: total ?? addresses.length, count: addresses.length, v2_only: true, addresses}),
  });
  global.fetch = fn as typeof fetch;
  return fn;
}

function mockFetchPages(pages: { addresses: string[]; total: number }[]) {
  let callIndex = 0;
  const fn = jest.fn().mockImplementation(async () => {
    const page = pages[callIndex++];
    if (!page) throw new Error("Unexpected extra fetch call");
    return {
      ok: true,
      json: async () => ({
        status: "ok",
        total: page.total,
        count: page.addresses.length,
        v2_only: true,
        addresses: page.addresses,
      }),
    };
  });
  global.fetch = fn as typeof fetch;
  return fn;
}

describe("BlacklistingService", () => {
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

      const verdicts = await svc.checkBlacklist(["0xtest"]);
      expect(verdicts[0].is_bot).toBe(false);
    });

    it("malformed response (no addresses array) throws", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({status: "ok", total: 0}),
      }) as typeof fetch;

      const svc = new BlacklistingService(SERVICE_URL);
      await expect(svc.loadBlacklist()).rejects.toThrow(/malformed/);
    });

    it("timeout wraps as descriptive error with offset", async () => {
      const abortError = new DOMException("The operation was aborted", "AbortError");
      global.fetch = jest.fn().mockRejectedValue(abortError) as typeof fetch;

      const svc = new BlacklistingService(SERVICE_URL, 100);
      await expect(svc.loadBlacklist()).rejects.toThrow(/timed out/);
    });
  });

  describe("pagination", () => {
    it("fetches multiple pages and combines all addresses", async () => {
      const fn = mockFetchPages([
        { addresses: ["0xa", "0xb", "0xc"], total: 5 },
        { addresses: ["0xd", "0xe"], total: 5 },
      ]);

      const svc = new BlacklistingService(SERVICE_URL, 30_000, 3);
      await svc.loadBlacklist();

      expect(svc.getBlacklistCount()).toBe(5);
      expect(fn).toHaveBeenCalledTimes(2);

      // verify offset params
      const url0 = new URL(fn.mock.calls[0][0]);
      expect(url0.searchParams.get("offset")).toBe("0");
      expect(url0.searchParams.get("limit")).toBe("3");
      const url1 = new URL(fn.mock.calls[1][0]);
      expect(url1.searchParams.get("offset")).toBe("3");
    });

    it("stops after first page if count < pageSize", async () => {
      const fn = mockFetchOk(["0xa", "0xb"]);

      const svc = new BlacklistingService(SERVICE_URL, 30_000, 1000);
      await svc.loadBlacklist();

      expect(fn).toHaveBeenCalledTimes(1);
      expect(svc.getBlacklistCount()).toBe(2);
    });

    it("does not update blacklist if a middle page fails", async () => {
      // Pre-load a valid blacklist
      mockFetchOk(["0xoriginal"]);
      const svc = new BlacklistingService(SERVICE_URL, 30_000, 2);
      await svc.loadBlacklist();
      expect(svc.getBlacklistCount()).toBe(1);

      // Now mock: page 1 ok, page 2 fails
      let callIndex = 0;
      global.fetch = jest.fn().mockImplementation(async () => {
        callIndex++;
        if (callIndex === 1) {
          return {
            ok: true,
            json: async () => ({ status: "ok", total: 4, count: 2, v2_only: true, addresses: ["0xnew1", "0xnew2"] }),
          };
        }
        throw new Error("network error on page 2");
      }) as typeof fetch;

      await expect(svc.loadBlacklist()).rejects.toThrow(/network error/);

      // Original blacklist should still be intact
      expect(svc.getBlacklistCount()).toBe(1);
      const verdicts = await svc.checkBlacklist(["0xoriginal"]);
      expect(verdicts[0].is_bot).toBe(true);
    });

    it("handles empty blacklist (total=0)", async () => {
      mockFetchPages([{ addresses: [], total: 0 }]);

      const svc = new BlacklistingService(SERVICE_URL, 30_000, 1000);
      await svc.loadBlacklist();

      expect(svc.getBlacklistCount()).toBe(0);
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
