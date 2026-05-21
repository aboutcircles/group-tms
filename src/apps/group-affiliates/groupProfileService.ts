import { getAddress } from "ethers";

export interface IGroupProfileService {
  fetchMinRepScores(groupAddresses: readonly string[]): Promise<Record<string, number>>;
}

type GroupProfileResponse = {
  address?: unknown;
  minRepScore?: unknown;
};

export class GroupProfileService implements IGroupProfileService {
  constructor(
    private readonly profileBaseUrl: string,
    private readonly timeoutMs: number = 30_000
  ) {
  }

  async fetchMinRepScores(groupAddresses: readonly string[]): Promise<Record<string, number>> {
    const uniqueGroups = Array.from(new Set(groupAddresses.map((address) => getAddress(address).toLowerCase())));
    const entries = await Promise.all(uniqueGroups.map(async (group) => {
      const minRepScore = await this.fetchMinRepScore(group);
      return [group, minRepScore] as const;
    }));
    return Object.fromEntries(entries);
  }

  private async fetchMinRepScore(group: string): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.profileBaseUrl.replace(/\/+$/, "")}/${group}`, {
        method: "GET",
        headers: {"accept": "application/json"},
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`group profile request failed for ${group}: HTTP ${response.status}`);
      }

      const payload = await response.json() as GroupProfileResponse;
      const minRepScore = parseMinRepScore(payload.minRepScore);
      if (minRepScore === null) {
        throw new Error(`group profile ${group} does not include a valid minRepScore`);
      }

      return minRepScore;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseMinRepScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
