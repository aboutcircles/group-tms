import {__testables, ScoreCache} from "../../../src/apps/gnosis-group/logic";

const {
  fetchRelativeTrustScores,
  formatErrorMessage,
  getScoreForAddress,
  isBlacklisted,
  isRetryableFetchError,
  normalizeAddress,
  resolveScoreThreshold,
  timedFetch,
  uniqueNormalizedAddresses
} = __testables;

describe("gnosis-group helpers", () => {
  afterEach(() => {
    delete process.env.GNOSIS_GROUP_SCORE_THRESHOLD;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("aborts fetch requests that exceed the configured timeout", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    jest.useFakeTimers();
    const fetchPromise = timedFetch("https://scores.local", {method: "POST"}, 1_000);
    const expectation = expect(fetchPromise).rejects.toThrow("aborted");

    await jest.advanceTimersByTimeAsync(1_000);
    await expectation;
  });

  it("classifies retryable fetch errors", () => {
    expect(isRetryableFetchError("temporary issue")).toBe(true);
    expect(isRetryableFetchError({code: "NETWORK_ERROR"})).toBe(true);
    expect(isRetryableFetchError({name: "AbortError"})).toBe(true);
    expect(isRetryableFetchError({message: "network timeout"})).toBe(true);
    expect(isRetryableFetchError({name: "TypeError", code: "NONRETRY", message: "fatal"})).toBe(false);
  });

  it("classifies blacklist verdicts", () => {
    expect(isBlacklisted({address: "0x1", is_bot: true} as any)).toBe(true);
    expect(isBlacklisted({address: "0x1", is_bot: false, category: "flagged"} as any)).toBe(true);
    expect(isBlacklisted({address: "0x1", is_bot: false} as any)).toBe(false);
  });

  it("resolves score thresholds from config, env, and defaults", () => {
    const logger = {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      table: jest.fn(),
      child: jest.fn()
    };

    expect(resolveScoreThreshold(77, logger as any)).toBe(77);

    process.env.GNOSIS_GROUP_SCORE_THRESHOLD = "55";
    expect(resolveScoreThreshold(undefined, logger as any)).toBe(55);

    process.env.GNOSIS_GROUP_SCORE_THRESHOLD = "invalid";
    expect(resolveScoreThreshold(undefined, logger as any)).toBe(100);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("extracts scores from mixed-case keys", () => {
    expect(getScoreForAddress({"0xabc": 1}, "0xabc")).toBe(1);
    expect(getScoreForAddress({"0xabc": 2}, "0xAbC")).toBe(2);
    expect(getScoreForAddress({"0XABC": 3}, "0xabc")).toBe(3);
    expect(getScoreForAddress({}, "0xabc")).toBe(0);
  });

  it("formats non-Error values safely", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
    expect(formatErrorMessage("plain")).toBe("plain");
    expect(formatErrorMessage({code: 42})).toBe("[object Object]");
  });

  it("stores and expires cached scores", () => {
    const cache = new ScoreCache();
    jest.spyOn(Date, "now").mockReturnValue(1_000);
    cache.set("0xABC", 42);

    expect(cache.get("0xabc")).toEqual({score: 42, fetchedAt: 1_000});
    expect(cache.getValidScore("0xabc", 100)).toBe(42);

    jest.spyOn(Date, "now").mockReturnValue(2_000);
    expect(cache.getValidScore("0xabc", 100)).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("normalizes and deduplicates helper address inputs", () => {
    const first = "0x1000000000000000000000000000000000000001";
    const second = "0x1000000000000000000000000000000000000002";

    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("bad-address")).toBeNull();
    expect(uniqueNormalizedAddresses([first, first.toLowerCase(), second, "bad-address", 123 as any])).toEqual([
      "0x1000000000000000000000000000000000000001",
      "0x1000000000000000000000000000000000000002"
    ]);
  });

  it("parses relative trust score responses and skips malformed entries", async () => {
    const valid = "0x4000000000000000000000000000000000000004";
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "success",
        batches: {
          "0": [
            {address: valid, relative_score: 42},
            {},
            {address: "not-an-address", relative_score: 99},
            {address: valid, relative_score: "44"},
            {address: valid, relative_score: "oops"}
          ],
          "1": "invalid-batch"
        }
      })
    });

    const results = await fetchRelativeTrustScores("https://scores.local", [valid], [valid]);
    expect(results.get("0x4000000000000000000000000000000000000004")).toBe(44);
  });

  it("throws on non-200 or malformed relative trust score responses", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Unavailable"
    });

    await expect(
      fetchRelativeTrustScores("https://scores.local", [], [])
    ).rejects.toThrow("HTTP 503 Unavailable");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({status: "error"})
    });

    await expect(
      fetchRelativeTrustScores("https://scores.local", [], [])
    ).rejects.toThrow("response malformed");
  });
});
