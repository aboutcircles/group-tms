import {
  DEFAULT_COMMUNITY_REPUTATION_SCORES_URL,
  resolveCommunityReputationConfig
} from "../../../src/apps/community-new/reputationConfig";

describe("resolveCommunityReputationConfig", () => {
  it("defaults bulk reputation to the backend's score_group scores endpoint", () => {
    expect(resolveCommunityReputationConfig({})).toEqual({
      baseUrl: "",
      scoresUrl: DEFAULT_COMMUNITY_REPUTATION_SCORES_URL,
      useBulk: true
    });
    expect(DEFAULT_COMMUNITY_REPUTATION_SCORES_URL).toBe(
      "https://rpc.aboutcircles.com/analytics/rep_score/groups/score_group/scores"
    );
  });

  it("derives a matching scores endpoint from an explicit per-address base URL", () => {
    expect(resolveCommunityReputationConfig({
      COMMUNITY_NEW_REPUTATION_BASE_URL: "https://rep.example/groups/custom/avatars/"
    })).toEqual({
      baseUrl: "https://rep.example/groups/custom/avatars/",
      scoresUrl: "https://rep.example/groups/custom/scores",
      useBulk: true
    });
  });

  it("preserves per-address mode for a custom base URL without a derivable bulk route", () => {
    expect(resolveCommunityReputationConfig({
      COMMUNITY_NEW_REPUTATION_BASE_URL: "https://rep.example/avatar-score"
    })).toEqual({
      baseUrl: "https://rep.example/avatar-score",
      scoresUrl: "",
      useBulk: false
    });
  });

  it("requires an explicit per-address base URL when bulk mode is disabled", () => {
    expect(() => resolveCommunityReputationConfig({
      COMMUNITY_NEW_REPUTATION_BULK: "0"
    })).toThrow(
      "COMMUNITY_NEW_REPUTATION_BASE_URL is required when COMMUNITY_NEW_REPUTATION_BULK=0"
    );
  });
});
