export type RouterEnablementSource = "fallback" | "base-group";

export type RouterEnablementStatus = {
  avatar: string;
  fallbackEnabled: boolean;
  baseGroupEnabled: boolean;
};

export interface IRouterEnablementStore {
  /**
   * Returns enablement status for avatars already processed for routing.
   */
  loadEnablementStatuses(): Promise<RouterEnablementStatus[]>;

  /**
   * Records the provided avatar addresses as having been enabled for routing
   * for the specified source.
   */
  markEnabled(addresses: string[], source: RouterEnablementSource): Promise<void>;

  /**
   * Returns addresses currently quarantined (not yet expired).
   * Implementations should evict entries whose TTL has elapsed.
   */
  loadQuarantinedAddresses(): Promise<string[]>;

  /**
   * Records the provided addresses as quarantined (cause on-chain reverts).
   *
   * Every address passed in gets a fresh TTL running from this call, including
   * one that was already quarantined. Callers that want an existing entry to
   * expire on its original schedule must therefore filter it out rather than
   * re-submit it, which is what `runOnce` does when it passes only the newly
   * quarantined addresses.
   */
  markQuarantined(addresses: string[]): Promise<void>;
}
