import {GroupProfileService} from "../../../src/apps/group-affiliates/groupProfileService";

const GROUP_A = "0xde6c6ecb280c6fa535000f2d5bbb8dfdf460d161";
const GROUP_B = "0x4e2564e5df6c1fb10c1a018538de36e4d5844de5";

describe("GroupProfileService", () => {
  it("fetches minRepScore values for managed groups", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({
        address: url.endsWith(GROUP_A) ? GROUP_A : GROUP_B,
        minRepScore: url.endsWith(GROUP_A) ? 36 : "51"
      })
    }));

    const service = new GroupProfileService("https://staging.circlesubi.network/profiles/profile");

    await expect(service.fetchMinRepScores([GROUP_A, GROUP_B])).resolves.toEqual({
      [GROUP_A]: 36,
      [GROUP_B]: 51
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://staging.circlesubi.network/profiles/profile/${GROUP_A}`,
      expect.objectContaining({method: "GET"})
    );
  });

  it("fails closed when a group profile has no valid minRepScore", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({address: GROUP_A})
    });

    const service = new GroupProfileService("https://staging.circlesubi.network/profiles/profile");

    await expect(service.fetchMinRepScores([GROUP_A]))
      .rejects
      .toThrow(`group profile ${GROUP_A} does not include a valid minRepScore`);
  });
});
