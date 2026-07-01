export type AffiliateGroupMember = {
  avatarName: string | null;
  avatarAddress: string;
  timestamp: number;
};

/**
 * Reads intent and confirmed community membership from the multi-affiliate RPC.
 */
export interface IAffiliateGroupsRpc {
  fetchAllGroupMembersWishlist(groupAddress: string, pageSize?: number): Promise<AffiliateGroupMember[]>;
  fetchAllGroupMembers(groupAddress: string, pageSize?: number): Promise<AffiliateGroupMember[]>;
  fetchAffiliateGroupFeesPercentage(avatarAddress: string): Promise<number>;
}
