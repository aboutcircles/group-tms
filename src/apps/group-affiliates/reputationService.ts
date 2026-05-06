import {getAddress} from "ethers";

export type ReputationVerdict = {
  address: string;
  reputationScore: number | null;
  eligible: boolean;
};

export interface IReputationService {
  check(addresses: string[], threshold: number): Promise<Map<string, ReputationVerdict>>;
}

type ReputationResponse = {
  address?: unknown;
  reputation_score?: unknown;
};

export class ReputationService implements IReputationService {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 30_000
  ) {
  }

  async check(addresses: string[], threshold: number): Promise<Map<string, ReputationVerdict>> {
    const unique = Array.from(new Set(addresses.map((address) => getAddress(address).toLowerCase())));
    const entries = await Promise.all(unique.map((address) => this.fetchVerdict(address, threshold)));
    return new Map(entries.map((entry) => [entry.address, entry]));
  }

  private async fetchVerdict(address: string, threshold: number): Promise<ReputationVerdict> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/${address}`, {
        method: "GET",
        headers: {"accept": "application/json"},
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`reputation request failed for ${address}: HTTP ${response.status}`);
      }

      const payload = await response.json() as ReputationResponse;
      const score = parseScore(payload.reputation_score);
      return {
        address,
        reputationScore: score,
        eligible: score !== null && score > threshold
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
