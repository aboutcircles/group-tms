export const DEFAULT_COMMUNITY_REPUTATION_SCORES_URL =
  "https://rpc.aboutcircles.com/analytics/rep_score/groups/score_group/scores";

export type CommunityReputationConfig = {
  baseUrl: string;
  scoresUrl: string;
  useBulk: boolean;
};

export function resolveCommunityReputationConfig(
  env: NodeJS.ProcessEnv
): CommunityReputationConfig {
  const baseUrl = env.COMMUNITY_NEW_REPUTATION_BASE_URL?.trim() ?? "";
  const explicitScoresUrl = env.COMMUNITY_NEW_REPUTATION_SCORES_URL?.trim() ?? "";
  const derivedScoresUrl = /\/avatars\/*$/.test(baseUrl)
    ? baseUrl.replace(/\/avatars\/*$/, "/scores")
    : "";
  const scoresUrl = explicitScoresUrl || derivedScoresUrl ||
    (baseUrl.length === 0 ? DEFAULT_COMMUNITY_REPUTATION_SCORES_URL : "");
  const useBulk = env.COMMUNITY_NEW_REPUTATION_BULK !== "0" && scoresUrl.length > 0;

  if (!useBulk && baseUrl.length === 0) {
    throw new Error(
      "COMMUNITY_NEW_REPUTATION_BASE_URL is required when COMMUNITY_NEW_REPUTATION_BULK=0"
    );
  }

  return {baseUrl, scoresUrl, useBulk};
}
