// The analytics rep_score service exposes the default ScoreGroup under the slug
// `score_group_v2` (or its address form 0x93ed5a96…); the older `score_group`
// slug 404s ("Unknown group: score_group") and silently yields no scores.
export const DEFAULT_COMMUNITY_REPUTATION_SCORES_URL =
  "https://rpc.aboutcircles.com/analytics/rep_score/groups/score_group_v2/scores";

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
