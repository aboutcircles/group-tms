import {SafeOwnershipError} from "../../src/services/safeTransactionExecutor";

describe("SafeOwnershipError", () => {
  it("stores signer and safe addresses", () => {
    const err = new SafeOwnershipError("0xSignerAddress", "0xSafeAddress");
    expect(err.signerAddress).toBe("0xSignerAddress");
    expect(err.safeAddress).toBe("0xSafeAddress");
    expect(err.name).toBe("SafeOwnershipError");
  });

  it("includes actionable guidance in error message", () => {
    const err = new SafeOwnershipError("0xABC", "0xDEF");
    expect(err.message).toContain("GS026");
    expect(err.message).toContain("0xABC");
    expect(err.message).toContain("0xDEF");
    expect(err.message).toContain("SAFE_SIGNER_PRIVATE_KEY");
  });
});
