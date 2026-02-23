export type SafeTrustState = {
  trustedAvatar: string;
  trustedTimestamp: string;
  switchCount: number;
};

export interface IAvatarSafeMappingStore {
  /**
   * Loads the previously persisted avatar → safe mapping.
   * Returns an empty map when no prior state exists.
   * Keys are checksum avatar addresses, values are checksum safe addresses.
   */
  load(): Promise<Map<string, string>>;

  /**
   * Atomically persists the avatar → safe mapping, fully replacing
   * the previous state.
   */
  save(mapping: Map<string, string>): Promise<void>;

  /** Loads per-safe trust state used for switch-capping logic. */
  loadSafeTrustState(): Promise<Map<string, SafeTrustState>>;

  /** Persists per-safe trust state, fully replacing the previous state. */
  saveSafeTrustState(state: Map<string, SafeTrustState>): Promise<void>;
}
