import {getAddress} from "ethers";

import {IRouterEnablementStore} from "../../interfaces/IRouterEnablementStore";

const DEFAULT_QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function normalize(address: string): string {
  return getAddress(address).toLowerCase();
}

export class InMemoryRouterEnablementStore implements IRouterEnablementStore {
  private readonly enabled = new Set<string>();
  private readonly quarantined = new Map<string, number>();
  private readonly quarantineTtlMs: number;

  constructor(initialAddresses: string[] = [], quarantineTtlMs: number = DEFAULT_QUARANTINE_TTL_MS) {
    this.quarantineTtlMs = quarantineTtlMs;
    this.addAddresses(initialAddresses);
  }

  async loadEnabledAddresses(): Promise<string[]> {
    return Array.from(this.enabled);
  }

  async markEnabled(addresses: string[]): Promise<void> {
    this.addAddresses(addresses);
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

  private addAddresses(addresses: string[]): void {
    for (const address of addresses) {
      try {
        this.enabled.add(normalize(address));
      } catch {
        // Ignore invalid addresses provided by callers.
      }
    }
  }
}
