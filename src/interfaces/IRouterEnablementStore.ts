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
}
