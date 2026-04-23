import {getAddress} from "ethers";

import {
  IRouterEnablementStore,
  RouterEnablementSource,
  RouterEnablementStatus
} from "../../interfaces/IRouterEnablementStore";

const DEFAULT_QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function normalize(address: string): string {
  return getAddress(address).toLowerCase();
}

export class InMemoryRouterEnablementStore implements IRouterEnablementStore {
  private readonly enabled = new Map<string, RouterEnablementStatus>();
  private readonly quarantined = new Map<string, number>();
  private readonly quarantineTtlMs: number;

  constructor(initialAddresses: string[] = [], quarantineTtlMs: number = DEFAULT_QUARANTINE_TTL_MS) {
    this.quarantineTtlMs = quarantineTtlMs;
    this.addAddresses(initialAddresses, "base-group");
  }

  async loadEnablementStatuses(): Promise<RouterEnablementStatus[]> {
    return Array.from(this.enabled.values()).map((status) => ({...status}));
  }

  async markEnabled(addresses: string[], source: RouterEnablementSource): Promise<void> {
    this.addAddresses(addresses, source);
  }

  async loadQuarantinedAddresses(): Promise<string[]> {
    const now = Date.now();
    const expired: string[] = [];
    for (const [addr, ts] of this.quarantined) {
      if (now - ts > this.quarantineTtlMs) {
        expired.push(addr);
      }
    }
    for (const addr of expired) {
      this.quarantined.delete(addr);
    }
    return Array.from(this.quarantined.keys());
  }

  async markQuarantined(addresses: string[]): Promise<void> {
    const now = Date.now();
    for (const address of addresses) {
      try {
        this.quarantined.set(normalize(address), now);
      } catch {
        // Ignore invalid addresses
      }
    }
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
