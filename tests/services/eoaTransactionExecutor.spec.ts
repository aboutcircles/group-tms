import {
  EoaTransactionConfirmationTimeoutError,
  EoaTransactionExecutor
} from "../../src/services/eoaTransactionExecutor";

describe("EoaTransactionConfirmationTimeoutError", () => {
  it("stores txHash and timeoutMs", () => {
    const err = new EoaTransactionConfirmationTimeoutError("0xabc", 5000);

    expect(err.txHash).toBe("0xabc");
    expect(err.timeoutMs).toBe(5000);
    expect(err.name).toBe("EoaTransactionConfirmationTimeoutError");
    expect(err.message).toContain("0xabc");
    expect(err.message).toContain("5000");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("EoaTransactionExecutor", () => {
  it("requires a signer private key", () => {
    expect(() => new EoaTransactionExecutor("http://localhost:8545", ""))
      .toThrow("EOA signer private key is required");
  });

  it("derives the signer address", () => {
    const executor = new EoaTransactionExecutor(
      "http://localhost:8545",
      "0x0000000000000000000000000000000000000000000000000000000000000001"
    );

    expect(executor.getSignerAddress()).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  });
});
