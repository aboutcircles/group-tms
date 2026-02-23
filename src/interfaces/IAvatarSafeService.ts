export type SafeOwnerSelection = {
  avatar: string;
  timestamp: string;
};

export type AvatarSafeResult = {
  /** Selected avatar → safe mapping (one avatar per safe). */
  mappings: Map<string, string>;
  /** Per-safe selected owner (latest timestamp among requested avatars). */
  selectedOwnersBySafe: Map<string, SafeOwnerSelection>;
};

export interface IAvatarSafeService {
  /**
   * Returns avatar → safe mappings based only on latest owner timestamp.
   * Exactly one owner is selected per safe.
   */
  findAvatarsWithSafes(avatars: string[]): Promise<AvatarSafeResult>;
}
