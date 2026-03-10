import {Interface} from "ethers";
import CirclesBackingABI from "../../src/abi/CirclesBackingABI.json";
import {BackingInstanceService} from "../../src/services/backingInstanceService";

// Build the real interface so we can encode genuine custom error selectors
const iface = new Interface(CirclesBackingABI);

// Helper: encode a custom error's 4-byte selector (+ args if any)
function encodeCustomError(name: string, args: any[] = []): string {
  return iface.encodeErrorResult(iface.getError(name)!, args);
}

// We can't easily mock ethers Contract internals, so we test parseCustomError
// directly and test simulate* via constructor mocking.

describe("BackingInstanceService.parseCustomError", () => {
  // parseCustomError is public, so we can test it on a real instance
  let service: BackingInstanceService;
  let fakeContract: any;

  beforeEach(() => {
    // Construct without signer — we only need the provider for parseCustomError
    service = new BackingInstanceService("http://localhost:8545");
    // Build a contract-like object with the real interface
    fakeContract = {interface: iface};
  });

  it("finds error data in err.data (most common ethers v6 path)", () => {
    const data = encodeCustomError("LBPAlreadyCreated");
    const name = service.parseCustomError(fakeContract, {data});
    expect(name).toBe("LBPAlreadyCreated");
  });

  it("finds error data in err.error.data (nested provider error)", () => {
    const data = encodeCustomError("OrderAlreadySettled");
    const name = service.parseCustomError(fakeContract, {error: {data}});
    expect(name).toBe("OrderAlreadySettled");
  });

  it("finds error data in err.info.error.data (ethers v6 CALL_EXCEPTION)", () => {
    const data = encodeCustomError("OrderUidIsTheSame");
    const name = service.parseCustomError(fakeContract, {info: {error: {data}}});
    expect(name).toBe("OrderUidIsTheSame");
  });

  it("finds error data in err.info.data", () => {
    const data = encodeCustomError("OrderNotYetFilled");
    const name = service.parseCustomError(fakeContract, {info: {data}});
    expect(name).toBe("OrderNotYetFilled");
  });

  it("finds error data in err.cause.data", () => {
    const data = encodeCustomError("BackingAssetBalanceInsufficient", [100, 200]);
    const name = service.parseCustomError(fakeContract, {cause: {data}});
    expect(name).toBe("BackingAssetBalanceInsufficient");
  });

  it("falls back to string matching in err.message", () => {
    const name = service.parseCustomError(fakeContract, {
      message: 'execution reverted: custom error "LBPAlreadyCreated"',
    });
    expect(name).toBe("LBPAlreadyCreated");
  });

  it("falls back to string matching in err.reason", () => {
    const name = service.parseCustomError(fakeContract, {
      reason: "OrderAlreadySettled()",
    });
    expect(name).toBe("OrderAlreadySettled");
  });

  it("falls back to string matching in err.shortMessage", () => {
    const name = service.parseCustomError(fakeContract, {
      shortMessage: "call revert exception: OrderNotYetFilled",
    });
    expect(name).toBe("OrderNotYetFilled");
  });

  // --- Edge cases ---

  it("returns undefined when error has no data and no matching strings", () => {
    const name = service.parseCustomError(fakeContract, {
      message: "something completely unrelated",
    });
    expect(name).toBeUndefined();
  });

  it("returns undefined for completely empty error object", () => {
    expect(service.parseCustomError(fakeContract, {})).toBeUndefined();
  });

  it("data is valid hex but unknown selector → returns undefined", () => {
    // 4 bytes that don't match any ABI error
    const name = service.parseCustomError(fakeContract, {data: "0xdeadbeef"});
    expect(name).toBeUndefined();
  });

  it("data is non-hex string → returns undefined (doesn't throw)", () => {
    const name = service.parseCustomError(fakeContract, {data: "not hex at all"});
    expect(name).toBeUndefined();
  });

  it("data is a number → returns undefined (doesn't throw)", () => {
    const name = service.parseCustomError(fakeContract, {data: 12345});
    expect(name).toBeUndefined();
  });

  it("first candidate slot has garbage, later slot has real data → finds it", () => {
    const data = encodeCustomError("OrderAlreadySettled");
    const name = service.parseCustomError(fakeContract, {
      data: "not valid",        // slot 1: garbage
      error: {data: 42},        // slot 2: wrong type
      info: {error: {data}},    // slot 3: real data
    });
    expect(name).toBe("OrderAlreadySettled");
  });
});

describe("BackingInstanceService executor guard", () => {
  it("resetCowSwapOrder throws when no signer configured", async () => {
    const svc = new BackingInstanceService("http://localhost:8545");
    await expect(svc.resetCowSwapOrder("0x1234")).rejects.toThrow(/configured Safe signer/);
  });

  it("createLbp throws when no signer configured", async () => {
    const svc = new BackingInstanceService("http://localhost:8545");
    await expect(svc.createLbp("0x1234")).rejects.toThrow(/configured Safe signer/);
  });

  it("constructor with empty signer string → no executor", async () => {
    const svc = new BackingInstanceService("http://localhost:8545", "  ", "0xSafe");
    await expect(svc.resetCowSwapOrder("0x1234")).rejects.toThrow(/configured Safe signer/);
  });

  it("constructor with empty safe string → no executor", async () => {
    const svc = new BackingInstanceService("http://localhost:8545", "0xPK", "  ");
    await expect(svc.createLbp("0x1234")).rejects.toThrow(/configured Safe signer/);
  });
});
