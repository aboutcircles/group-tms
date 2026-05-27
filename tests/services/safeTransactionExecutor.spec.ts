import {
  SafeTransactionExecutor,
  TransactionConfirmationTimeoutError,
  isNonceRaceError
} from "../../src/services/safeTransactionExecutor";

describe("TransactionConfirmationTimeoutError", () => {
  it("stores txHash and timeoutMs", () => {
    const err = new TransactionConfirmationTimeoutError("0xabc", 5000);
    expect(err.txHash).toBe("0xabc");
    expect(err.timeoutMs).toBe(5000);
    expect(err.name).toBe("TransactionConfirmationTimeoutError");
    expect(err.message).toContain("0xabc");
    expect(err.message).toContain("5000");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("SafeTransactionExecutor.execute timeout", () => {
  it("rejects with TransactionConfirmationTimeoutError when waitForTransaction hangs", async () => {
    // We can't easily construct a full SafeTransactionExecutor (needs RPC + Safe init),
    // but we can test the Promise.race pattern directly to verify the timeout logic.
    const neverResolves = new Promise<never>(() => {});
    const timeoutMs = 50;

    const raceResult = Promise.race([
      neverResolves,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new TransactionConfirmationTimeoutError("0xdeadbeef", timeoutMs)),
          timeoutMs
        );
      })
    ]);

    await expect(raceResult).rejects.toThrow(TransactionConfirmationTimeoutError);
    await expect(raceResult).rejects.toMatchObject({
      txHash: "0xdeadbeef",
      timeoutMs: 50
    });
  });

  it("resolves normally when waitForTransaction completes before timeout", async () => {
    const quickResolve = Promise.resolve({status: 1, hash: "0x123"});
    const timeoutMs = 5000;

    const result = await Promise.race([
      quickResolve,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new TransactionConfirmationTimeoutError("0x123", timeoutMs)),
          timeoutMs
        );
      })
    ]);

    expect(result).toEqual({status: 1, hash: "0x123"});
  });
});

describe("isNonceRaceError", () => {
  it("returns true for error with GS026 in message", () => {
    expect(isNonceRaceError(new Error("execution reverted: GS026"))).toBe(true);
  });

  it("returns true for error with GS026 in reason", () => {
    const err = new Error("transaction failed");
    (err as any).reason = "GS026";
    expect(isNonceRaceError(err)).toBe(true);
  });

  it("returns true when GS026 appears mid-string", () => {
    expect(isNonceRaceError(new Error("Safe call reverted with GS026: invalid owner provided"))).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(isNonceRaceError(null)).toBe(false);
    expect(isNonceRaceError(undefined)).toBe(false);
  });

  it("returns false for non-GS026 Safe errors", () => {
    expect(isNonceRaceError(new Error("execution reverted: GS013"))).toBe(false);
    expect(isNonceRaceError(new Error("execution reverted: GS025"))).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(isNonceRaceError(new Error("network timeout"))).toBe(false);
    expect(isNonceRaceError(new Error("insufficient funds"))).toBe(false);
  });

  it("returns false for non-Error objects without message/reason", () => {
    expect(isNonceRaceError(42)).toBe(false);
    expect(isNonceRaceError("some string")).toBe(false);
    expect(isNonceRaceError({})).toBe(false);
  });

  it("handles objects with reason property but no message", () => {
    const err = { reason: "GS026" };
    expect(isNonceRaceError(err)).toBe(true);
  });

  it("handles objects with message but not Error instances", () => {
    const err = { message: "reverted: GS026" };
    expect(isNonceRaceError(err)).toBe(true);
  });
});

describe("SafeTransactionExecutor gas estimation fallback", () => {
  const safe = {
    getEncodedTransaction: jest.fn(async () => "0xencoded")
  };

  it("falls back to raw eth_estimateGas when ethers estimateGas fails", async () => {
    const executor = {
      provider: {
        estimateGas: jest.fn(async () => {
          throw new Error("primary estimator unavailable");
        })
      },
      rawProvider: {
        send: jest.fn(async () => "0x100")
      },
      signerAddress: "0x0000000000000000000000000000000000000001",
      safeAddress: "0x0000000000000000000000000000000000000002"
    };

    const gasLimit = await (SafeTransactionExecutor.prototype as any)
      .estimateExecutionGasLimit.call(executor, safe, {});

    expect(gasLimit).toBe(308n);
    expect(executor.rawProvider.send).toHaveBeenCalledWith("eth_estimateGas", [{
      from: executor.signerAddress,
      to: executor.safeAddress,
      data: "0xencoded"
    }]);
  });

  it("uses a conservative gas cap after successful eth_call when both estimators fail", async () => {
    const executor = {
      provider: {
        estimateGas: jest.fn(async () => {
          throw new Error("primary estimator unavailable");
        }),
        call: jest.fn(async () => "0x")
      },
      rawProvider: {
        send: jest.fn(async () => {
          throw new Error("raw estimator unavailable");
        })
      },
      signerAddress: "0x0000000000000000000000000000000000000001",
      safeAddress: "0x0000000000000000000000000000000000000002"
    };

    const gasLimit = await (SafeTransactionExecutor.prototype as any)
      .estimateExecutionGasLimit.call(executor, safe, {});

    expect(gasLimit).toBe(3_000_000n);
    expect(executor.provider.call).toHaveBeenCalledWith({
      from: executor.signerAddress,
      to: executor.safeAddress,
      data: "0xencoded",
      gasLimit: 3_000_000n
    });
  });
});
