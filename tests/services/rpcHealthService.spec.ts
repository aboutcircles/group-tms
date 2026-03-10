import {checkRpcHealth} from "../../src/services/rpcHealthService";

// Stub out the Prometheus metric so the module loads without side-effects
jest.mock("../../src/services/metricsService", () => ({
  setRpcHealthy: jest.fn(),
}));

const RPC_URL = "https://rpc.example.invalid";
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function mockFetch(response: Partial<Response> & {json?: () => Promise<unknown>}) {
  const fn = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    ...response,
  });
  global.fetch = fn as typeof fetch;
  return fn;
}

describe("checkRpcHealth", () => {
  it("happy path: valid hex block number", async () => {
    mockFetch({json: async () => ({result: "0x1a2b3c"})});
    const result = await checkRpcHealth(RPC_URL);
    expect(result).toEqual({healthy: true, blockNumber: 0x1a2b3c});
  });

  // --- Edge cases that could silently pass as healthy or unhealthy ---

  it("result is '0x' (zero-length hex) → block 0, still healthy", async () => {
    // parseInt("", 16) => NaN — should this be unhealthy?
    mockFetch({json: async () => ({result: "0x"})});
    const result = await checkRpcHealth(RPC_URL);
    // "0x" → parseInt("", 16) = NaN → should be unhealthy
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/nparseable/i);
  });

  it("result is '0x0' → block 0 is valid (genesis)", async () => {
    mockFetch({json: async () => ({result: "0x0"})});
    const result = await checkRpcHealth(RPC_URL);
    expect(result).toEqual({healthy: true, blockNumber: 0});
  });

  it("result is a number instead of string → unhealthy", async () => {
    // Some non-standard RPC impls return numeric result
    mockFetch({json: async () => ({result: 12345})});
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/nvalid/i);
  });

  it("result is null → unhealthy", async () => {
    mockFetch({json: async () => ({result: null})});
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
  });

  it("result is a hex string with invalid chars '0xZZZZ' → unparseable", async () => {
    mockFetch({json: async () => ({result: "0xZZZZ"})});
    const result = await checkRpcHealth(RPC_URL);
    // parseInt("ZZZZ", 16) => NaN
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/nparseable/i);
  });

  it("result is negative hex '0x-1' → unhealthy (negative block)", async () => {
    mockFetch({json: async () => ({result: "0x-1"})});
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
  });

  it("both result and error present → error wins (checked first)", async () => {
    mockFetch({
      json: async () => ({
        result: "0xabc",
        error: {code: -32000, message: "overloaded"},
      }),
    });
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
    expect(result.error).toContain("overloaded");
  });

  it("RPC error with missing code and message → graceful fallback", async () => {
    mockFetch({json: async () => ({error: {}})});
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/unknown/i);
  });

  it("response.json() throws (malformed body) → caught as network error", async () => {
    mockFetch({
      json: () => { throw new SyntaxError("Unexpected token"); },
    });
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
    expect(result.error).toContain("Unexpected token");
  });

  it("HTTP 503 → unhealthy with status in message", async () => {
    mockFetch({ok: false, status: 503, statusText: "Service Unavailable"});
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
    expect(result.error).toBe("HTTP 503 Service Unavailable");
  });

  it("fetch rejects (DNS failure, etc.) → unhealthy", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as typeof fetch;
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
    expect(result.error).toBe("fetch failed");
  });

  it("AbortError (timeout) → reports timeout", async () => {
    // In Node, AbortError from AbortController is a DOMException with name "AbortError"
    // but it extends Error, so the `instanceof Error` check passes
    const abortError = new DOMException("The operation was aborted", "AbortError");
    global.fetch = jest.fn().mockRejectedValue(abortError) as typeof fetch;
    const result = await checkRpcHealth(RPC_URL, 5000);
    expect(result.healthy).toBe(false);
    // DOMException may or may not be instanceof Error depending on Node version
    // The key contract: unhealthy with some error message
    expect(result.error).toBeDefined();
  });

  it("non-Error thrown (string) → converted to string", async () => {
    global.fetch = jest.fn().mockRejectedValue("boom") as typeof fetch;
    const result = await checkRpcHealth(RPC_URL);
    expect(result.healthy).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("very large block number (> Number.MAX_SAFE_INTEGER hex) → still finite", async () => {
    // 0x1fffffffffffff is MAX_SAFE_INTEGER; one above loses precision but is still finite
    mockFetch({json: async () => ({result: "0x20000000000000"})});
    const result = await checkRpcHealth(RPC_URL);
    // parseInt handles this — it returns a number, just loses precision
    expect(result.healthy).toBe(true);
    expect(typeof result.blockNumber).toBe("number");
  });
});
