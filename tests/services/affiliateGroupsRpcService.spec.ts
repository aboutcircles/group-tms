import {AffiliateGroupsRpcService} from "../../src/services/affiliateGroupsRpcService";

const RPC_URL = "https://rpc.staging.aboutcircles.com";
const GROUP = "0x4e2564e5df6c1fb10c1a018538de36e4d5844de5";
const AVATAR_A = "0x1000000000000000000000000000000000000001";
const AVATAR_B = "0x2000000000000000000000000000000000000002";

function rpcResponse(result: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({jsonrpc: "2.0", id: 1, result})
  };
}

describe("AffiliateGroupsRpcService", () => {
  it("paginates the group wishlist using opaque cursors", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(rpcResponse({
        results: [{avatarName: "A", avatarAddress: AVATAR_A, timestamp: 10}],
        hasMore: true,
        nextCursor: "opaque-page-2"
      }))
      .mockResolvedValueOnce(rpcResponse({
        results: [{avatarName: null, avatarAddress: AVATAR_B, timestamp: 9}],
        hasMore: false,
        nextCursor: null
      }));
    const service = new AffiliateGroupsRpcService(RPC_URL);

    await expect(service.fetchAllGroupMembersWishlist(GROUP, 50)).resolves.toEqual([
      {avatarName: "A", avatarAddress: AVATAR_A, timestamp: 10},
      {avatarName: null, avatarAddress: AVATAR_B, timestamp: 9}
    ]);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody).toMatchObject({
      method: "circles_getAffiliateGroupMembersWishlist",
      params: [GROUP, 50]
    });
    expect(secondBody.params).toEqual([GROUP, 50, "opaque-page-2"]);
  });

  it("reads and validates an avatar's aggregate wishlist fee", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(rpcResponse({totalFeePercentage: 100}));
    const service = new AffiliateGroupsRpcService(RPC_URL);

    await expect(service.fetchAffiliateGroupFeesPercentage(AVATAR_A)).resolves.toBe(100);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({
      method: "circles_getAffiliateGroupFeesPercentage",
      params: [AVATAR_A]
    });
  });

  it("retries a rate-limited fee request after the server's Retry-After delay", async () => {
    jest.useFakeTimers();
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({"retry-after": "2"})
      })
      .mockResolvedValueOnce(rpcResponse({totalFeePercentage: 25}));
    const service = new AffiliateGroupsRpcService(RPC_URL);

    try {
      const result = service.fetchAffiliateGroupFeesPercentage(AVATAR_A);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(25);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("surfaces JSON-RPC errors instead of treating them as empty results", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: {code: -32601, message: "Method not found"}
      })
    });
    const service = new AffiliateGroupsRpcService(RPC_URL);

    await expect(service.fetchAllGroupMembers(GROUP))
      .rejects
      .toThrow("RPC error -32601: Method not found");
  });

  it("rejects a broken pagination response that could otherwise loop forever", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(rpcResponse({
      results: [],
      hasMore: true,
      nextCursor: null
    }));
    const service = new AffiliateGroupsRpcService(RPC_URL);

    await expect(service.fetchAllGroupMembersWishlist(GROUP))
      .rejects
      .toThrow("hasMore=true without nextCursor");
  });

  it("rejects invalid local addresses before issuing a request", async () => {
    const service = new AffiliateGroupsRpcService(RPC_URL);

    await expect(service.fetchAffiliateGroupFeesPercentage("not-an-address"))
      .rejects
      .toThrow("Invalid avatar address");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
