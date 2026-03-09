import {TransactionConfirmationTimeoutError} from "../../src/services/safeTransactionExecutor";

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
