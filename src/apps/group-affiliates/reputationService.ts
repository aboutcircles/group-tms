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

type ScoresItem = {
  address?: unknown;
  reputation_score?: unknown;
};

type ScoresPage = {
  total?: unknown;
  items?: unknown;
};

/**
 * Pulls the whole group reputation set from the rep_score `/scores`
 * endpoint in a few sequential pages instead of one HTTP request per
 * address. The per-address ReputationService fans out N requests across
 * thousands of trustees on the full-reconcile path, which blows the
 * rep_score service's request rate limit and aborts the run. Paging
 * `/scores` (limit 10 000) fetches the full member set in a single request
 * and serves repeated/incremental checks from a short-lived snapshot so
 * an event burst can't re-page on every event.
 */
export class BulkReputationService implements IReputationService {
  private snapshot: Map<string, number | null> | null = null;
  private snapshotBuiltAt = 0;

  constructor(
    private readonly scoresUrl: string,
    private readonly timeoutMs: number = 30_000,
    private readonly snapshotTtlMs: number = 5 * 60 * 1000,
    private readonly pageSize: number = 10_000
  ) {
  }

  async check(addresses: string[], threshold: number): Promise<Map<string, ReputationVerdict>> {
    const snapshot = await this.ensureSnapshot();
    const unique = Array.from(new Set(addresses.map((address) => getAddress(address).toLowerCase())));
    if (unique.length > 0 && snapshot.size === 0) {
      throw new Error("bulk reputation endpoint returned an empty snapshot for a non-empty address set");
    }
    return new Map(unique.map((address) => {
      // Absent from the group snapshot ⇒ not a scored member ⇒ ineligible.
      // Mirrors the per-address service, where a missing/failed lookup
      // also yields a non-eligible verdict.
      const score = snapshot.has(address) ? snapshot.get(address)! : null;
      return [address, {address, reputationScore: score, eligible: score !== null && score > threshold}];
    }));
  }

  private async ensureSnapshot(): Promise<Map<string, number | null>> {
    if (this.snapshot && Date.now() - this.snapshotBuiltAt < this.snapshotTtlMs) {
      return this.snapshot;
    }

    // Build into a local map and only publish on full success. A failure
    // partway through pagination must NOT yield a partial snapshot —
    // that would make real members look absent and mass-untrust them.
    const built = new Map<string, number | null>();
    let parsedScores = 0;
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    const base = this.scoresUrl.replace(/\/+$/, "");
    // Hard ceiling so a misbehaving API (always-full page) can't loop forever.
    const maxPages = 10_000;

    for (let page = 0; page < maxPages; page++) {
      const sep = base.includes("?") ? "&" : "?";
      const url = `${base}${sep}limit=${this.pageSize}&offset=${offset}&details=false`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let payload: ScoresPage;
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {"accept": "application/json"},
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`bulk reputation request failed at offset ${offset}: HTTP ${response.status}`);
        }
        payload = await response.json() as ScoresPage;
      } finally {
        clearTimeout(timeout);
      }

      if (typeof payload.total === "number" && Number.isFinite(payload.total)) {
        total = payload.total;
      }
      const items = Array.isArray(payload.items) ? payload.items as ScoresItem[] : [];
      for (const item of items) {
        if (typeof item.address !== "string" || item.address.trim().length === 0) {
          continue;
        }
        const score = parseScore(item.reputation_score);
        if (score !== null) {
          parsedScores++;
        }
        built.set(getAddress(item.address).toLowerCase(), score);
      }

      offset += items.length;
      if (items.length === 0 || items.length < this.pageSize || offset >= total) {
        break;
      }
    }

    // Contract guard: members reported but none had a parseable
    // reputation_score ⇒ the response shape changed. Fail loud rather
    // than silently treating every member as ineligible (mass-untrust).
    if (built.size > 0 && parsedScores === 0) {
      throw new Error(
        `bulk reputation: ${built.size} member(s) returned but none had a parseable ` +
        `reputation_score — rep_score /scores response shape may have changed`
      );
    }

    this.snapshot = built;
    this.snapshotBuiltAt = Date.now();
    return built;
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
