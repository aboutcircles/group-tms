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

  it("queries GraphQL with checksum-normalized addresses", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({data: {Metri_Pay_DelayModule: []}})
    } as MockJsonResponse);
    global.fetch = fetchMock as typeof fetch;

    const service = new MetriSafeService(endpoint, undefined);
    await service.findAvatarsWithSafes(["0xb00e2ed54bed3e4df0656781d36609c0b0138e98"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      variables?: {
        addresses?: string[];
      };
    };

    const checksum = getAddress("0xb00e2ed54bed3e4df0656781d36609c0b0138e98");
    expect(body.variables?.addresses).toEqual([checksum]);
  });

  it("maps owners even when GraphQL returns lowercase owner addresses", async () => {
    const owner = "0xb00e2ed54bed3e4df0656781d36609c0b0138e98";
    const safe = "0x13b0d6834e7d0a014166da74acdc277bce0bd365";

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          Metri_Pay_DelayModule: [
            {
              safeAddress: safe,
              owners: [
                {
                  ownerAddress: owner,
                  timestamp: "1699198580"
                }
              ]
            }
          ]
        }
      })
    } as MockJsonResponse);
    global.fetch = fetchMock as typeof fetch;

    const service = new MetriSafeService(endpoint, undefined);
    const result = await service.findAvatarsWithSafes([owner]);

    const ownerChecksum = getAddress(owner);
    const safeChecksum = getAddress(safe);
    expect(result.mappings.get(ownerChecksum)).toBe(safeChecksum);

    const selected = result.selectedOwnersBySafe.get(safeChecksum);
    expect(selected).toEqual({
      avatar: ownerChecksum,
      timestamp: "1699198580"
    });
  });
});
