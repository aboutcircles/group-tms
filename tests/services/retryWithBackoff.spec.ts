import { retryWithBackoff, isTransientRpcError } from "../../src/services/retryWithBackoff";

describe("isTransientRpcError", () => {
  it("returns true for code -32016", () => {
    expect(isTransientRpcError({ code: -32016, message: "some error" })).toBe(true);
  });

  it("returns true for nested error code -32016", () => {
    expect(isTransientRpcError({ error: { code: -32016 }, message: "x" })).toBe(true);
  });

  it.each(["timeout", "canceled", "cancelled", "ECONNRESET", "ECONNREFUSED", "socket hang up"])(
    "returns true for message containing '%s'",
    (keyword) => {
      expect(isTransientRpcError(new Error(`Request ${keyword} by server`))).toBe(true);
    }
  );

  it("returns false for revert error", () => {
    expect(isTransientRpcError(new Error("execution reverted"))).toBe(false);
  });

  it("returns false for nonce error", () => {
    expect(isTransientRpcError(new Error("nonce too low"))).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
  });
});

describe("retryWithBackoff", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns immediately on success", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error then succeeds", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("recovered");

    const promise = retryWithBackoff(fn, { baseDelayMs: 100 });
    // Advance past first backoff delay (100ms)
    await jest.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-transient error", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("execution reverted"));
    await expect(retryWithBackoff(fn)).rejects.toThrow("execution reverted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries on transient errors", async () => {
    jest.useRealTimers(); // real timers simpler for this case
    const fn = jest.fn().mockRejectedValue(new Error("socket hang up"));

    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 10 })
    ).rejects.toThrow("socket hang up");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("uses exponential backoff timing", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("ok");

    const promise = retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1000 });

    // First backoff: 1000ms
    await jest.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second backoff: 2000ms
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
