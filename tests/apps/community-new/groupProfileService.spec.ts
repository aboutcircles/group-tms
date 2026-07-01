import {CommunityGroupProfileService} from "../../../src/apps/community-new/groupProfileService";

const RPC_URL = "https://rpc.staging.aboutcircles.com";
const GROUP_A = "0x4e2564e5df6c1fb10c1a018538de36e4d5844de5";
const GROUP_B = "0x2709757a543cf1bf4d92586b73d3891438b2589d";

function response(result: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({jsonrpc: "2.0", id: 1, result})
  };
}

describe("CommunityGroupProfileService", () => {
  it("loads nested membershipCriteria.minRepScore values from the Circles RPC", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue(response([
      {address: GROUP_A, membershipCriteria: {minRepScore: 30, membershipFee: 5}},
      {address: GROUP_B, membershipCriteria: {minRepScore: "50", membershipFee: null}}
    ]));
    const service = new CommunityGroupProfileService(RPC_URL);

    await expect(service.fetchMinRepScores([GROUP_A, GROUP_B])).resolves.toEqual({
      [GROUP_A]: 30,
      [GROUP_B]: 50
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      method: "circles_getProfileByAddressBatch",
      params: [[GROUP_A, GROUP_B]]
    });
  });

  it("fails closed when a managed profile has no valid reputation requirement", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response([
      {address: GROUP_A, membershipCriteria: {membershipFee: 5}}
    ]));
    const service = new CommunityGroupProfileService(RPC_URL);

    await expect(service.fetchMinRepScores([GROUP_A]))
      .rejects
      .toThrow("does not include a valid membershipCriteria.minRepScore");
  });

  it("fails when the batch response does not cover every managed group", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response([null]));
    const service = new CommunityGroupProfileService(RPC_URL);

    await expect(service.fetchMinRepScores([GROUP_A]))
      .rejects
      .toThrow(`No group profile found for ${GROUP_A}`);
  });
});
