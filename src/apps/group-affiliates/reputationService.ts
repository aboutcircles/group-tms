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
    private readonly timeoutMs: number = 30_000,
    private readonly concurrency: number = 8
  ) {
  }

  async check(addresses: string[], threshold: number): Promise<Map<string, ReputationVerdict>> {
    const unique = Array.from(new Set(addresses.map((address) => getAddress(address).toLowerCase())));
    // Rolling-window concurrency: at most `concurrency` fetches in flight at
    // any time. Prevents the startup-replay path from firing hundreds of
    // simultaneous requests, which overwhelms both the local TCP stack
    // (undici ConnectTimeoutError on the connect queue) and the upstream
    // rep_score service (2-worker gunicorn → queue blow-up).
    const results = new Array<ReputationVerdict>(unique.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIndex++;
        if (i >= unique.length) {
          return;
        }
        results[i] = await this.fetchVerdict(unique[i], threshold);
      }
    };
    const workerCount = Math.max(1, Math.min(this.concurrency, unique.length));
    await Promise.all(Array.from({length: workerCount}, worker));
    return new Map(results.map((entry) => [entry.address, entry]));
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
