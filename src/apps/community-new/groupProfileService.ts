import {getAddress} from "ethers";

import {primaryRpcUrl} from "../../services/rpcProvider";
import {IGroupProfileService} from "../group-affiliates/groupProfileService";

type JsonRpcResponse = {
  result?: unknown;
  error?: {code?: unknown; message?: unknown};
};

/** Reads current membership criteria from Circles profiles over JSON-RPC. */
export class CommunityGroupProfileService implements IGroupProfileService {
  private requestId = 0;
  private readonly rpcUrl: string;

  constructor(rpcUrl: string, private readonly timeoutMs: number = 30_000) {
    this.rpcUrl = primaryRpcUrl(rpcUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Community profile RPC timeout must be a positive integer");
    }
  }

  async fetchMinRepScores(groupAddresses: readonly string[]): Promise<Record<string, number>> {
    const groups = Array.from(new Set(groupAddresses.map((group) => getAddress(group).toLowerCase())));
    if (groups.length === 0) return {};

    const result = await this.call("circles_getProfileByAddressBatch", [groups]);
    if (!Array.isArray(result) || result.length !== groups.length) {
      throw new Error(
        `circles_getProfileByAddressBatch returned ${Array.isArray(result) ? result.length : "a non-array"} ` +
        `for ${groups.length} managed group(s)`
      );
    }

    const thresholds: Record<string, number> = {};
    result.forEach((profile, index) => {
      const group = groups[index];
      if (!isRecord(profile)) {
        throw new Error(`No group profile found for ${group}`);
      }
      const criteria = profile.membershipCriteria;
      if (!isRecord(criteria)) {
        throw new Error(`group profile ${group} has no membershipCriteria`);
      }
      const minRepScore = parseNumber(criteria.minRepScore);
      if (minRepScore === null) {
        throw new Error(`group profile ${group} does not include a valid membershipCriteria.minRepScore`);
      }
      thresholds[group] = minRepScore;
    });
    return thresholds;
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: ++this.requestId, method, params}),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`${method} failed: HTTP ${response.status} ${response.statusText}`.trim());
      }

      const payload = await response.json() as JsonRpcResponse;
      if (payload.error) {
        const code = typeof payload.error.code === "number" ? ` ${payload.error.code}` : "";
        const message = typeof payload.error.message === "string" ? payload.error.message : "unknown RPC error";
        throw new Error(`${method} failed: RPC error${code}: ${message}`);
      }
      if (!("result" in payload)) {
        throw new Error(`${method} failed: JSON-RPC response has no result`);
      }
      return payload.result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${method} timed out after ${this.timeoutMs}ms`, {cause: error});
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
