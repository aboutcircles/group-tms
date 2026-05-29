import {__testables} from "../../src/services/gnosisAppUserService";
import {FakeLogger} from "../../fakes/fakes";

describe("gnosisAppUserService", () => {
  it("parses GnosisAppUser ids", () => {
    const ids = __testables.parseGnosisAppUserIds({
      data: {
        GnosisAppUser: [
          {id: "0x1000000000000000000000000000000000000001", createdAtBlock: 1},
          {id: 123},
          null
        ]
      }
    });

    expect(ids).toEqual(["0x1000000000000000000000000000000000000001"]);
  });

  it("filters GnosisAppUser ids through Avatar RegisterHuman rows", async () => {
    const registerHuman = "0x42cEDde51198D1773590311E2A340DC06B24cB37";
    const unclaimed = "0x55E0fF8d8eF8194aBF0F6378076193B4554376C6";
    const queries: string[] = [];
    const fetcher = jest.fn(async (query: string) => {
      queries.push(query);
      return {
        data: {
          Avatar: [
            {id: registerHuman, avatarType: "RegisterHuman"}
          ]
        }
      };
    });

    const result = await __testables.filterRegisterHumanAvatars(
      fetcher,
      [registerHuman, unclaimed],
      10,
      new FakeLogger(true)
    );

    expect(result).toEqual([registerHuman.toLowerCase()]);
    expect(queries[0]).toContain("Avatar");
    expect(queries[0]).toContain("id:{_in:");
    expect(queries[0]).toContain('avatarType:{_eq:"RegisterHuman"}');
    expect(queries[0]).toContain(registerHuman);
    expect(queries[0]).toContain(unclaimed);
    expect(queries[0]).not.toContain(registerHuman.toLowerCase());
  });

  it("fetches GnosisAppUser pages after a configured block", async () => {
    const registerHuman = "0x42cEDde51198D1773590311E2A340DC06B24cB37";
    const queries: string[] = [];
    const fetcher = jest.fn(async (query: string) => {
      queries.push(query);
      return {
        data: {
          GnosisAppUser: [
            {id: registerHuman, createdAtBlock: 12346}
          ]
        }
      };
    });

    const result = await __testables.fetchAllGnosisAppUserIds(
      fetcher,
      "https://example.invalid/graphql",
      1000,
      12345,
      new FakeLogger(true)
    );

    expect(result).toEqual([registerHuman]);
    expect(queries[0]).toContain("GnosisAppUser");
    expect(queries[0]).toContain("createdAtBlock:{_gt:12345}");
    expect(queries[0]).not.toContain("Avatar");
  });

  it("caps page sizes at the indexer limit", () => {
    expect(__testables.normalizePageSize(10_000)).toBe(1_000);
    expect(__testables.normalizePageSize(0)).toBe(1);
    expect(__testables.normalizePageSize(250)).toBe(250);
  });
});
