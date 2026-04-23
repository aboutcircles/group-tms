export interface IRouterEnablementStore {
  /**
   * Returns every avatar address that has already been enabled for routing.
   */
  loadEnabledAddresses(): Promise<string[]>;

  /**
   * Records the provided avatar addresses as having been enabled for routing.
   */
  markEnabled(addresses: string[]): Promise<void>;

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

