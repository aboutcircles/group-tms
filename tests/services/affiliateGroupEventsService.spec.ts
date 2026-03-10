import {AffiliateGroupEventsService} from "../../src/services/affiliateGroupEventsService";
import {isTransientRpcError} from "../../src/services/retryWithBackoff";

// --- Mock ethers provider ---
const mockGetBlockNumber = jest.fn();
const mockGetLogs = jest.fn();

jest.mock("ethers", () => {
  const actual = jest.requireActual("ethers");
  return {
    ...actual,
    JsonRpcProvider: jest.fn().mockImplementation(() => ({
      getBlockNumber: mockGetBlockNumber,
      getLogs: mockGetLogs,
    })),
  };
});

// Mock retryWithBackoff to run without delays but preserve retry semantics
jest.mock("../../src/services/retryWithBackoff", () => {
  const actual = jest.requireActual("../../src/services/retryWithBackoff");
  return {
    ...actual,
    retryWithBackoff: jest.fn(async (fn: () => Promise<any>, opts?: any) => {
      const maxRetries = opts?.maxRetries ?? 3;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastError = err;
          if (!actual.isTransientRpcError(err) || attempt >= maxRetries) {
            throw err;
          }
          // No delay in tests
        }
      }
      throw lastError;
    }),
  };
});

const REGISTRY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_GROUP = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const HUMAN_ADDR = "0x1111111111111111111111111111111111111111";

function makeLog(human: string, oldGroup: string, newGroup: string, blockNumber: number) {
  const actual = jest.requireActual("ethers");
  const iface = new actual.Interface([
    "event AffiliateGroupChanged(address indexed human, address oldGroup, address newGroup)",
  ]);
  const encoded = iface.encodeEventLog(
    iface.getEvent("AffiliateGroupChanged")!,
    [human, oldGroup, newGroup]
  );
  return {
    blockNumber,
    transactionHash: `0xtx${blockNumber}`,
    topics: encoded.topics,
    data: encoded.data,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("AffiliateGroupEventsService", () => {
  // --- Chunking edge cases ---

  it("fromBlock > latest → returns empty, zero getLogs calls", async () => {
    mockGetBlockNumber.mockResolvedValue(100);
    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    const events = await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 200, 100);
    expect(mockGetLogs).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("fromBlock === toBlock → exactly 1 chunk, 1 getLogs call", async () => {
    mockGetLogs.mockResolvedValue([]);
    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    const events = await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 500, 500);
    expect(mockGetLogs).toHaveBeenCalledTimes(1);
    // The fromBlock and toBlock in the call should both be 500
    expect(mockGetLogs.mock.calls[0][0]).toMatchObject({fromBlock: 500, toBlock: 500});
    expect(events).toEqual([]);
  });

  it("range exactly equals chunkSize → single chunk (no off-by-one)", async () => {
    // chunkSize default is 100000, range [0, 99999] = 100000 blocks = 1 chunk
    mockGetLogs.mockResolvedValue([]);
    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 0, 99999);
    expect(mockGetLogs).toHaveBeenCalledTimes(1);
  });

  it("range = chunkSize + 1 → exactly 2 chunks", async () => {
    mockGetLogs.mockResolvedValue([]);
    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 0, 100000);
    expect(mockGetLogs).toHaveBeenCalledTimes(2);
    // First chunk: [0, 99999], second: [100000, 100000]
    expect(mockGetLogs.mock.calls[0][0]).toMatchObject({fromBlock: 0, toBlock: 99999});
    expect(mockGetLogs.mock.calls[1][0]).toMatchObject({fromBlock: 100000, toBlock: 100000});
  });

  // --- Filtering edge cases ---

  it("filters events matching oldGroup to target (case-insensitive)", async () => {
    // ethers checksums addresses in decoded output, so matching is done via toLowerCase()
    const log = makeLog(HUMAN_ADDR, TARGET_GROUP, ZERO_ADDR, 10);
    mockGetLogs.mockResolvedValue([log]);
    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    // Pass target with different case — the service lowercases both sides
    const events = await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1, 100);
    expect(events).toHaveLength(1);
  });

  it("filters events matching newGroup to target", async () => {
    const log = makeLog(HUMAN_ADDR, ZERO_ADDR, TARGET_GROUP, 20);
    mockGetLogs.mockResolvedValue([log]);
    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    const events = await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1, 100);
    expect(events).toHaveLength(1);
  });

  it("excludes events where neither old nor new group matches target", async () => {
    const log = makeLog(HUMAN_ADDR, "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333", 30);
    mockGetLogs.mockResolvedValue([log]);
    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    const events = await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1, 100);
    expect(events).toEqual([]);
  });

  // --- Retry logic edge cases ---

  it("retries on timeout error (code -32016) and succeeds", async () => {
    const timeoutErr = Object.assign(new Error("timeout"), {code: -32016});
    const log = makeLog(HUMAN_ADDR, TARGET_GROUP, ZERO_ADDR, 50);

    mockGetLogs
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce([log]);

    const svc = new AffiliateGroupEventsService("http://rpc.invalid");

    const events = await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1, 100);
    expect(mockGetLogs).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
  });

  it("retries on 'canceled' message (without error code)", async () => {
    const cancelErr = new Error("request canceled by client");
    mockGetLogs
      .mockRejectedValueOnce(cancelErr)
      .mockResolvedValueOnce([]);

    const svc = new AffiliateGroupEventsService("http://rpc.invalid");

    await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1, 100);
    expect(mockGetLogs).toHaveBeenCalledTimes(2);
  });

  it("non-timeout error throws immediately without retry", async () => {
    const fatalErr = new Error("execution reverted");
    mockGetLogs.mockRejectedValueOnce(fatalErr);

    const svc = new AffiliateGroupEventsService("http://rpc.invalid");

    await expect(
      svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1, 100)
    ).rejects.toThrow("execution reverted");
    expect(mockGetLogs).toHaveBeenCalledTimes(1);
  });

  it("exceeds maxRetries → throws the timeout error", async () => {
    const timeoutErr = Object.assign(new Error("timeout"), {code: -32016});
    mockGetLogs.mockRejectedValue(timeoutErr);

    const svc = new AffiliateGroupEventsService("http://rpc.invalid");

    await expect(
      svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1, 100)
    ).rejects.toThrow("timeout");
    // 1 initial + 3 retries = 4 calls
    expect(mockGetLogs).toHaveBeenCalledTimes(4);
  });

  it("error on 2nd chunk after 1st succeeds → partial data lost, error thrown", async () => {
    const log = makeLog(HUMAN_ADDR, TARGET_GROUP, ZERO_ADDR, 5);
    const fatalErr = new Error("provider crashed");

    mockGetLogs
      .mockResolvedValueOnce([log])   // chunk 1 OK
      .mockRejectedValueOnce(fatalErr); // chunk 2 fails

    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    // Use small chunkSize to force 2 chunks
    (svc as any).chunkSize = 50;

    await expect(
      svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1, 100)
    ).rejects.toThrow("provider crashed");
  });

  // --- toBlock omitted → uses getBlockNumber ---

  it("omitting toBlock calls getBlockNumber for latest", async () => {
    mockGetBlockNumber.mockResolvedValue(42);
    mockGetLogs.mockResolvedValue([]);

    const svc = new AffiliateGroupEventsService("http://rpc.invalid");
    await svc.fetchAffiliateGroupChanged(REGISTRY, TARGET_GROUP, 1);

    expect(mockGetBlockNumber).toHaveBeenCalledTimes(1);
    expect(mockGetLogs.mock.calls[0][0].toBlock).toBe(42);
  });
});
