import {BulkReputationService} from "../../../src/apps/group-affiliates/reputationService";

const A = "0x1000000000000000000000000000000000000001";
const B = "0x1000000000000000000000000000000000000002";
const C = "0x1000000000000000000000000000000000000003";
const URL = "http://advanced-analytics:8080/rep_score/groups/gnosis/scores";

function pageResponse(total: number, items: Array<{address: string; reputation_score: unknown}>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({total, items})
  } as unknown as Response;
}

describe("BulkReputationService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("pages the /scores endpoint and gates eligibility on the threshold", async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(pageResponse(3, [
        {address: A, reputation_score: 75},
        {address: B, reputation_score: 10}
      ]))
      .mockResolvedValueOnce(pageResponse(3, [
        {address: C, reputation_score: "55"}
      ]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new BulkReputationService(URL, 5_000, 60_000, 2);
    const result = await svc.check([A, B, C], 40);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("limit=2&offset=0");
    expect(fetchMock.mock.calls[1][0]).toContain("offset=2");
    expect(result.get(A.toLowerCase())).toEqual({address: A.toLowerCase(), reputationScore: 75, eligible: true});
    expect(result.get(B.toLowerCase())).toEqual({address: B.toLowerCase(), reputationScore: 10, eligible: false});
    expect(result.get(C.toLowerCase())).toEqual({address: C.toLowerCase(), reputationScore: 55, eligible: true});
  });

  it("treats addresses absent from the snapshot as ineligible", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      pageResponse(1, [{address: A, reputation_score: 90}])
    ) as unknown as typeof fetch;

    const svc = new BulkReputationService(URL, 5_000, 60_000, 100);
    const result = await svc.check([A, B], 40);

    expect(result.get(A.toLowerCase())?.eligible).toBe(true);
    expect(result.get(B.toLowerCase())).toEqual({address: B.toLowerCase(), reputationScore: null, eligible: false});
  });

  it("throws (no partial snapshot) when a page request fails", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(pageResponse(4, [{address: A, reputation_score: 90}, {address: B, reputation_score: 90}]))
      .mockResolvedValueOnce({ok: false, status: 503, json: async () => ({})} as unknown as Response) as unknown as typeof fetch;

    const svc = new BulkReputationService(URL, 5_000, 60_000, 2);
    await expect(svc.check([A], 40)).rejects.toThrow(/HTTP 503/);
  });

  it("fails loud when members are returned but none have a parseable score", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      pageResponse(2, [{address: A, reputation_score: null}, {address: B, reputation_score: "n/a"}])
    ) as unknown as typeof fetch;

    const svc = new BulkReputationService(URL, 5_000, 60_000, 100);
    await expect(svc.check([A], 40)).rejects.toThrow(/response shape may have changed/);
  });

  it("serves repeated checks from the cached snapshot within the TTL", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      pageResponse(1, [{address: A, reputation_score: 90}])
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new BulkReputationService(URL, 5_000, 60_000, 100);
    await svc.check([A], 40);
    await svc.check([A], 40);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
