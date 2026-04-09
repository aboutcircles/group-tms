import {getAddress} from "ethers";

import {
  IRouterEnablementStore,
  RouterEnablementSource,
  RouterEnablementStatus
} from "../../interfaces/IRouterEnablementStore";

function normalize(address: string): string {
  return getAddress(address).toLowerCase();
}

export class InMemoryRouterEnablementStore implements IRouterEnablementStore {
  private readonly enabled = new Map<string, RouterEnablementStatus>();

  constructor(initialAddresses: string[] = []) {
    this.addAddresses(initialAddresses, "base-group");
  }

  async loadEnablementStatuses(): Promise<RouterEnablementStatus[]> {
    return Array.from(this.enabled.values()).map((status) => ({...status}));
  }

  async markEnabled(addresses: string[], source: RouterEnablementSource): Promise<void> {
    this.addAddresses(addresses, source);
  }

  private addAddresses(addresses: string[], source: RouterEnablementSource): void {
    for (const address of addresses) {
      try {
        const normalized = normalize(address);
        const existing = this.enabled.get(normalized) ?? {
          avatar: normalized,
          fallbackEnabled: false,
          baseGroupEnabled: false
        };

        if (source === "fallback") {
          existing.fallbackEnabled = true;
        } else {
          existing.baseGroupEnabled = true;
        }

        this.enabled.set(normalized, existing);
      } catch {
        // Ignore invalid addresses provided by callers.
      }
    }
  }
}
