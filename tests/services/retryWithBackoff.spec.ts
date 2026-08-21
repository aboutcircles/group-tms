import { retryWithBackoff, isTransientRpcError } from "../../src/services/retryWithBackoff";

describe("isTransientRpcError", () => {
  it("returns true for code -32016", () => {
    expect(isTransientRpcError({ code: -32016, message: "some error" })).toBe(true);
  });

  it("returns true for nested error code -32016", () => {
    expect(isTransientRpcError({ error: { code: -32016 }, message: "x" })).toBe(true);
  });

  it.each(["timeout", "canceled", "cancelled", "ECONNRESET", "ECONNREFUSED", "socket hang up", "Too Many Requests"])(
    "returns true for message containing '%s'",
    (keyword) => {
      expect(isTransientRpcError(new Error(`Request ${keyword} by server`))).toBe(true);
    }
  );

  it("returns true for standalone 429 in message", () => {
    expect(isTransientRpcError(new Error("HTTP 429 rate limited"))).toBe(true);
    expect(isTransientRpcError(new Error("status 429"))).toBe(true);
  });

  it("returns false when 429 is part of a larger number (e.g. block 42900001)", () => {
    expect(isTransientRpcError(new Error("block 42900001 not found"))).toBe(false);
  });

  it("returns true for numeric status/statusCode 429", () => {
    expect(isTransientRpcError({ status: 429, message: "rate limited" })).toBe(true);
    expect(isTransientRpcError({ statusCode: 429, message: "rate limited" })).toBe(true);
  });

  it("returns true for numeric code 429", () => {
    expect(isTransientRpcError({ code: 429, message: "error" })).toBe(true);
  });

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

  // sdk-rpc reports a rate limit as a generic connection failure and puts the
  // 429 on .cause. Classifying only the outer error reads that as permanent.
  it("returns true for a 429 wrapped as .cause behind an opaque message", () => {
    const wrapped = new Error("Failed to connect to RPC endpoint", {
      cause: new Error("HTTP 429: Too Many Requests")
    });
    expect(isTransientRpcError(wrapped)).toBe(true);
  });

  it("returns true for a 429 nested two causes deep", () => {
    const inner = new Error("HTTP 429: Too Many Requests");
    const middle = new Error("request failed", {cause: inner});
    const outer = new Error("Failed to connect to RPC endpoint", {cause: middle});
    expect(isTransientRpcError(outer)).toBe(true);
  });

  it("returns false when nothing in the cause chain is transient", () => {
    const wrapped = new Error("Failed to connect to RPC endpoint", {
      cause: new Error("execution reverted")
    });
    expect(isTransientRpcError(wrapped)).toBe(false);
  });

  it("terminates on a circular cause chain", () => {
    const a: any = new Error("outer boom");
    const b: any = new Error("inner boom");
    a.cause = b;
    b.cause = a;
    expect(isTransientRpcError(a)).toBe(false);
  });

  it("terminates when an error is its own cause", () => {
    const self: any = new Error("self boom");
    self.cause = self;
    expect(isTransientRpcError(self)).toBe(false);
  });

  // The data-less CALL_EXCEPTION heuristic guesses that the node failed to
  // simulate. A nested one says nothing about the call we made, and honouring it
  // would retry genuine reverts.
  it("ignores a data-less CALL_EXCEPTION found in the cause chain", () => {
    const wrapped: any = new Error("trust simulation failed", {
      cause: Object.assign(new Error("call exception"), {code: "CALL_EXCEPTION", data: null})
    });
    expect(isTransientRpcError(wrapped)).toBe(false);
  });

  it("still honours a data-less CALL_EXCEPTION on the outermost error", () => {
    const err: any = Object.assign(new Error("call exception"), {code: "CALL_EXCEPTION", data: null});
    expect(isTransientRpcError(err)).toBe(true);
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

  it("honors a retryAfterMs hint from the transient error", async () => {
    const rateLimitError = Object.assign(new Error("HTTP 429 Too Many Requests"), {
      status: 429,
      retryAfterMs: 2_000
    });
    const fn = jest.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("recovered");

    const promise = retryWithBackoff(fn, {baseDelayMs: 100});
    await jest.advanceTimersByTimeAsync(1_999);
    expect(fn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
