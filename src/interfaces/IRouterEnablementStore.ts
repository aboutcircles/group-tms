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
   * Each entry starts a fresh TTL from the time of this call.
   */
  markQuarantined(addresses: string[]): Promise<void>;
}
