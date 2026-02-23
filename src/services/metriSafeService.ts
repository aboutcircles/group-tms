import {getAddress} from "ethers";
import {
  type AvatarSafeResult,
  IAvatarSafeService,
  SafeOwnerSelection
} from "../interfaces/IAvatarSafeService";

type DelayModuleOwner = {
  ownerAddress?: string | null;
  timestamp?: unknown;
};

type DelayModule = {
  safeAddress?: string | null;
  owners?: DelayModuleOwner[] | null;
};

type GraphqlResponse = {
  data?: {
    Metri_Pay_DelayModule?: DelayModule[] | null;
  } | null;
  errors?: Array<{message?: string}> | null;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CHUNK_SIZE = 2500;

const QUERY = `query($addresses:[String!]!){
  Metri_Pay_DelayModule(where:{owners:{ownerAddress:{_in:$addresses}}}){
    safeAddress
    owners(where:{ownerAddress:{_in:$addresses}}){
      ownerAddress
      timestamp
    }
  }
}`;

export class MetriSafeService implements IAvatarSafeService {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly chunkSize: number = DEFAULT_CHUNK_SIZE
  ) {
    if (!endpoint || endpoint.trim().length === 0) {
      throw new Error("MetriSafeService requires a non-empty endpoint");
    }
  }

  async findAvatarsWithSafes(avatars: string[]): Promise<AvatarSafeResult> {
    const normalized = normalizeAddresses(avatars);
    if (normalized.length === 0) {
      return {mappings: new Map(), selectedOwnersBySafe: new Map()};
    }

    const requested = new Set(normalized);
    const selectedOwnersBySafe = new Map<string, SafeOwnerSelection>();

    for (let index = 0; index < normalized.length; index += this.chunkSize) {
      const chunk = normalized.slice(index, index + this.chunkSize);
      const modules = await this.fetchModules(chunk);
      this.mergeModules(selectedOwnersBySafe, requested, modules);
    }

    const mappings = new Map<string, string>();
    for (const [safe, selected] of selectedOwnersBySafe.entries()) {
      mappings.set(selected.avatar, safe);
    }

    return {mappings, selectedOwnersBySafe};
  }

  private async fetchModules(addresses: string[]): Promise<DelayModule[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (this.apiKey && this.apiKey.trim().length > 0) {
        headers["x-api-key"] = this.apiKey.trim();
      }

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: QUERY,
          variables: {addresses}
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`MetriSafeService request failed: HTTP ${response.status} ${response.statusText}`);
      }

      const payload = await response.json() as GraphqlResponse;
      if (payload.errors && payload.errors.length > 0) {
        const messages = payload.errors
          .map((e) => e?.message)
          .filter((m): m is string => typeof m === "string" && m.length > 0);
        throw new Error(`MetriSafeService GraphQL error: ${messages.join(", ")}`);
      }

      const modules = payload.data?.Metri_Pay_DelayModule;
      if (!Array.isArray(modules)) {
        return [];
      }

      return modules;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("MetriSafeService request timed out");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private mergeModules(
    accumulator: Map<string, SafeOwnerSelection>,
    requested: Set<string>,
    modules: DelayModule[]
  ): void {
    for (const module of modules) {
      const safe = normalizeAddress(module.safeAddress);
      if (!safe) {
        continue;
      }

      const owners = Array.isArray(module.owners) ? module.owners : [];
      for (const owner of owners) {
        const avatar = normalizeAddress(owner.ownerAddress);
        if (!avatar) {
          continue;
        }
        if (!requested.has(avatar)) {
          continue;
        }

        const timestamp = normalizeTimestamp(owner.timestamp);
        if (!timestamp) {
          continue;
        }

        const existing = accumulator.get(safe);
        if (!existing || compareTimestamp(timestamp, existing.timestamp) > 0) {
          accumulator.set(safe, {avatar, timestamp});
        }
      }
    }
  }
}

function normalizeAddresses(addresses: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of addresses) {
    const normalizedAddress = normalizeAddress(value);
    if (!normalizedAddress) {
      continue;
    }
    if (seen.has(normalizedAddress)) {
      continue;
    }
    seen.add(normalizedAddress);
    normalized.push(normalizedAddress);
  }
  return normalized;
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function compareTimestamp(left: string, right: string): number {
  const leftBigInt = toComparableBigInt(left);
  const rightBigInt = toComparableBigInt(right);

  if (leftBigInt !== null && rightBigInt !== null) {
    if (leftBigInt > rightBigInt) return 1;
    if (leftBigInt < rightBigInt) return -1;
    return 0;
  }

  return left.localeCompare(right);
}

function toComparableBigInt(value: string): bigint | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return BigInt(trimmed);
  }

  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return BigInt(parsedDate);
  }

  return null;
}
