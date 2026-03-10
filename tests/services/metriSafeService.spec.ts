import {getAddress} from "ethers";
import {MetriSafeService} from "../../src/services/metriSafeService";

type MockJsonResponse = {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
};

describe("MetriSafeService", () => {
  const endpoint = "https://example.invalid/graphql";
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockFetchOk(payload: unknown) {
    const fn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    } as MockJsonResponse);
    global.fetch = fn as typeof fetch;
    return fn;
  }

  it("queries GraphQL with checksum-normalized addresses", async () => {
    const fetchMock = mockFetchOk({data: {Metri_Pay_DelayModule: []}});

    const service = new MetriSafeService(endpoint, undefined);
    await service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      variables?: {addresses?: string[]};
    };

    const checksum = getAddress("0xb00e2ed54bed3e4df0656781d36609c0b0138e98");
    expect(body.variables?.addresses).toEqual([checksum]);
  });

  it("maps owners even when GraphQL returns lowercase owner addresses", async () => {
    const owner = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    const safe = "0x13b0d6834e7d0a014166da74acdc277bce0bd365";

    mockFetchOk({
      data: {
        Metri_Pay_DelayModule: [{
          safeAddress: safe,
          owners: [{ownerAddress: owner, timestamp: "1699198580"}],
        }],
      },
    });

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes([owner]);

    const ownerChecksum = getAddress(owner);
    const safeChecksum = getAddress(safe);
    expect(result.mappings.get(ownerChecksum)).toBe(safeChecksum);
    expect(result.selectedOwnersBySafe.get(safeChecksum)).toEqual({
      avatar: ownerChecksum,
      timestamp: "1699198580",
    });
  });

  // --- Edge cases: GraphQL errors ---

  it("GraphQL response with errors[] → throws with joined messages", async () => {
    mockFetchOk({
      errors: [{message: "field not found"}, {message: "rate limited"}],
      data: null,
    });

    const service = new MetriSafeService(endpoint, undefined);
    await expect(service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]))
      .rejects.toThrow(/field not found.*rate limited/);
  });

  it("GraphQL error with empty message objects → filters them out", async () => {
    mockFetchOk({
      errors: [{}, {message: ""}, {message: "real error"}],
      data: null,
    });

    const service = new MetriSafeService(endpoint, undefined);
    await expect(service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]))
      .rejects.toThrow("real error");
  });

  // --- Edge cases: multiple owners for same safe ---

  it("picks owner with latest timestamp when multiple owners exist for same safe", async () => {
    const owner1 = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    const owner2 = "0x13b0d6834e7d0a014166da74acdc277bce0bd365";
    const safe = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

    mockFetchOk({
      data: {
        Metri_Pay_DelayModule: [{
          safeAddress: safe,
          owners: [
            {ownerAddress: owner1, timestamp: "1000"},
            {ownerAddress: owner2, timestamp: "2000"}, // newer
          ],
        }],
      },
    });

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes([owner1, owner2]);

    const safeChecksum = getAddress(safe);
    const selected = result.selectedOwnersBySafe.get(safeChecksum);
    expect(selected?.avatar).toBe(getAddress(owner2)); // owner2 has later timestamp
    expect(selected?.timestamp).toBe("2000");
  });

  it("handles bigint-like timestamp strings for comparison", async () => {
    const owner1 = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    const owner2 = "0x13b0d6834e7d0a014166da74acdc277bce0bd365";
    const safe = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

    mockFetchOk({
      data: {
        Metri_Pay_DelayModule: [{
          safeAddress: safe,
          owners: [
            {ownerAddress: owner1, timestamp: "99999999999999999"},
            {ownerAddress: owner2, timestamp: "100000000000000000"}, // larger bigint
          ],
        }],
      },
    });

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes([owner1, owner2]);

    const safeChecksum = getAddress(safe);
    expect(result.selectedOwnersBySafe.get(safeChecksum)?.avatar).toBe(getAddress(owner2));
  });

  // --- Edge cases: null/invalid data in modules ---

  it("module with null safeAddress → skipped", async () => {
    const owner = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    mockFetchOk({
      data: {
        Metri_Pay_DelayModule: [{
          safeAddress: null,
          owners: [{ownerAddress: owner, timestamp: "1000"}],
        }],
      },
    });

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes([owner]);
    expect(result.mappings.size).toBe(0);
  });

  it("owner with null ownerAddress → skipped", async () => {
    const safe = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    mockFetchOk({
      data: {
        Metri_Pay_DelayModule: [{
          safeAddress: safe,
          owners: [{ownerAddress: null, timestamp: "1000"}],
        }],
      },
    });

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]);
    expect(result.mappings.size).toBe(0);
  });

  it("owner with invalid address (not checksummable) → skipped", async () => {
    const safe = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    mockFetchOk({
      data: {
        Metri_Pay_DelayModule: [{
          safeAddress: safe,
          owners: [{ownerAddress: "not-an-address", timestamp: "1000"}],
        }],
      },
    });

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]);
    expect(result.mappings.size).toBe(0);
  });

  it("owner with null/undefined timestamp → skipped", async () => {
    const owner = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    const safe = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    mockFetchOk({
      data: {
        Metri_Pay_DelayModule: [{
          safeAddress: safe,
          owners: [{ownerAddress: owner, timestamp: null}],
        }],
      },
    });

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes([owner]);
    expect(result.mappings.size).toBe(0);
  });

  // --- Edge cases: chunking ---

  it("more addresses than chunkSize → multiple fetch calls, results merged", async () => {
    const owner1 = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    const owner2 = "0x13b0d6834e7d0a014166da74acdc277bce0bd365";
    const safe1 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const safe2 = "0xdac17f958d2ee523a2206206994597c13d831ec7";

    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            Metri_Pay_DelayModule: [{
              safeAddress: safe1,
              owners: [{ownerAddress: owner1, timestamp: "1000"}],
            }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            Metri_Pay_DelayModule: [{
              safeAddress: safe2,
              owners: [{ownerAddress: owner2, timestamp: "2000"}],
            }],
          },
        }),
      });
    global.fetch = fetchMock as typeof fetch;

    // chunkSize=1 forces two fetches
    const service = new MetriSafeService(endpoint, undefined, 30_000, 1);
    const result = await service.findAvatarsWithSafes([owner1, owner2]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.mappings.size).toBe(2);
  });

  // --- Edge cases: input normalization ---

  it("empty input → returns empty maps, no fetch", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes([]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mappings.size).toBe(0);
  });

  it("duplicate addresses → deduped before query", async () => {
    const addr = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    const fetchMock = mockFetchOk({data: {Metri_Pay_DelayModule: []}});

    const service = new MetriSafeService(endpoint, undefined);
    await service.findAvatarsWithSafes([addr, addr, addr]);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.variables.addresses).toHaveLength(1);
  });

  it("invalid addresses filtered out before query", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes(["not-valid", "", "  "]);

    // All invalid → empty normalized → no fetch
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mappings.size).toBe(0);
  });

  // --- Edge cases: HTTP errors ---

  it("HTTP error → throws with status code", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
    }) as typeof fetch;

    const service = new MetriSafeService(endpoint, undefined);
    await expect(service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]))
      .rejects.toThrow(/HTTP 502/);
  });

  it("constructor rejects empty endpoint", () => {
    expect(() => new MetriSafeService("", undefined)).toThrow(/non-empty endpoint/);
    expect(() => new MetriSafeService("   ", undefined)).toThrow(/non-empty endpoint/);
  });

  // --- Edge case: owner not in requested set → ignored ---

  it("owner returned by API but not in requested set → ignored", async () => {
    const requestedOwner = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    const unrequestedOwner = "0x13b0d6834e7d0a014166da74acdc277bce0bd365";
    const safe = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

    mockFetchOk({
      data: {
        Metri_Pay_DelayModule: [{
          safeAddress: safe,
          owners: [{ownerAddress: unrequestedOwner, timestamp: "1000"}],
        }],
      },
    });

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes([requestedOwner]);
    expect(result.mappings.size).toBe(0);
  });

  // --- Edge case: api key header ---

  it("sends x-api-key header when apiKey is provided", async () => {
    const fetchMock = mockFetchOk({data: {Metri_Pay_DelayModule: []}});

    const service = new MetriSafeService(endpoint, "my-secret-key");
    await service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]);

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("my-secret-key");
  });

  it("omits x-api-key header when apiKey is empty/whitespace", async () => {
    const fetchMock = mockFetchOk({data: {Metri_Pay_DelayModule: []}});

    const service = new MetriSafeService(endpoint, "  ");
    await service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]);

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
  });
});
