import {getAddress} from "ethers";

import {
  AffiliateGroupMember,
  IAffiliateGroupsRpc
} from "../interfaces/IAffiliateGroupsRpc";
import {primaryRpcUrl} from "./rpcProvider";
import {retryWithBackoff} from "./retryWithBackoff";

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

type JsonRpcError = {
  code?: unknown;
  message?: unknown;
};

type JsonRpcResponse = {
  result?: unknown;
  error?: JsonRpcError;
};

type MembersPage = {
  results: AffiliateGroupMember[];
  hasMore: boolean;
  nextCursor: string | null;
};

class AffiliateRpcHttpError extends Error {
  constructor(
    method: string,
    public readonly status: number,
    statusText: string,
    public readonly retryAfterMs?: number
  ) {
    super(`${method} failed: HTTP ${status} ${statusText}`.trim());
    this.name = "AffiliateRpcHttpError";
  }
}

/**
 * Raw JSON-RPC implementation used until rpc.affiliate.* is available in the
 * published SDK version consumed by this repository.
 */
export class AffiliateGroupsRpcService implements IAffiliateGroupsRpc {
  private requestId = 0;

  constructor(
    rpcUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly maxPages: number = DEFAULT_MAX_PAGES
  ) {
    this.rpcUrl = primaryRpcUrl(rpcUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Affiliate RPC timeout must be a positive integer");
    }
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new Error("Affiliate RPC maxPages must be a positive integer");
    }
  }

  private readonly rpcUrl: string;

  fetchAllGroupMembersWishlist(
    groupAddress: string,
    pageSize: number = DEFAULT_PAGE_SIZE
  ): Promise<AffiliateGroupMember[]> {
    return this.fetchAllMembers("circles_getAffiliateGroupMembersWishlist", groupAddress, pageSize);
  }

  /**
   * Startup probe: verifies the affiliate wishlist RPC method exists on the
   * configured node. The `circles_getAffiliateGroup*` methods are not served by
   * every Circles RPC (prod `rpc.aboutcircles.com` returns `-32601 Method not
   * found`). A single-page call surfaces a wrong-endpoint misconfiguration at
   * boot instead of after a poll cycle. Throws on any RPC/transport error.
   */
  async assertAffiliateMethodsAvailable(groupAddress: string): Promise<void> {
    const group = normalizeAddress(groupAddress, "group");
    await this.call("circles_getAffiliateGroupMembersWishlist", [group, 1]);
  }

  fetchAllGroupMembers(
    groupAddress: string,
    pageSize: number = DEFAULT_PAGE_SIZE
  ): Promise<AffiliateGroupMember[]> {
    return this.fetchAllMembers("circles_getAffiliateGroupMembers", groupAddress, pageSize);
  }

  async fetchAffiliateGroupFeesPercentage(avatarAddress: string): Promise<number> {
    const avatar = normalizeAddress(avatarAddress, "avatar");
    const result = await this.call("circles_getAffiliateGroupFeesPercentage", [avatar]);
    if (!isRecord(result)) {
      throw new Error("circles_getAffiliateGroupFeesPercentage returned a non-object result");
    }

    const total = result.totalFeePercentage;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
      throw new Error("circles_getAffiliateGroupFeesPercentage returned an invalid totalFeePercentage");
    }
    return total;
  }

  private async fetchAllMembers(
    method: "circles_getAffiliateGroupMembersWishlist" | "circles_getAffiliateGroupMembers",
    groupAddress: string,
    pageSize: number
  ): Promise<AffiliateGroupMember[]> {
    const group = normalizeAddress(groupAddress, "group");
    const limit = normalizePageSize(pageSize);
    const members = new Map<string, AffiliateGroupMember>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber++) {
      const params: unknown[] = cursor ? [group, limit, cursor] : [group, limit];
      const page = parseMembersPage(await this.call(method, params), method);
      for (const member of page.results) {
        members.set(member.avatarAddress, member);
      }

      if (!page.hasMore) {
        return Array.from(members.values());
      }
      if (!page.nextCursor) {
        throw new Error(`${method} returned hasMore=true without nextCursor`);
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error(`${method} returned a repeated pagination cursor`);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    throw new Error(`${method} exceeded the ${this.maxPages}-page safety limit`);
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    return retryWithBackoff(
      () => this.callOnce(method, params),
      {
        maxRetries: DEFAULT_MAX_RETRIES,
        baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
        maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS
      }
    );
  }

  private async callOnce(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const id = ++this.requestId;

    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id, method, params}),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new AffiliateRpcHttpError(
          method,
          response.status,
          response.statusText,
          parseRetryAfterHeader(response.headers.get("retry-after"))
        );
      }

      const payload = await response.json() as JsonRpcResponse;
      if (payload.error) {
        const code = typeof payload.error.code === "number" ? ` ${payload.error.code}` : "";
        const message = typeof payload.error.message === "string"
          ? payload.error.message
          : "unknown RPC error";
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

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}

function parseMembersPage(value: unknown, method: string): MembersPage {
  if (!isRecord(value) || !Array.isArray(value.results) || typeof value.hasMore !== "boolean") {
    throw new Error(`${method} returned an invalid members page`);
  }

  const nextCursor = value.nextCursor;
  if (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== "string") {
    throw new Error(`${method} returned an invalid nextCursor`);
  }

  return {
    results: value.results.map((member, index) => parseMember(member, method, index)),
    hasMore: value.hasMore,
    nextCursor: typeof nextCursor === "string" ? nextCursor : null
  };
}

function parseMember(value: unknown, method: string, index: number): AffiliateGroupMember {
  if (!isRecord(value)) {
    throw new Error(`${method} returned a non-object member at index ${index}`);
  }

  const avatarName = value.avatarName;
  const timestamp = value.timestamp;
  if (avatarName !== null && typeof avatarName !== "string") {
    throw new Error(`${method} returned an invalid avatarName at index ${index}`);
  }
  if (typeof value.avatarAddress !== "string") {
    throw new Error(`${method} returned an invalid avatarAddress at index ${index}`);
  }
  if (typeof timestamp !== "number" || !Number.isInteger(timestamp) || timestamp < 0) {
    throw new Error(`${method} returned an invalid timestamp at index ${index}`);
  }

  return {
    avatarName,
    avatarAddress: normalizeAddress(value.avatarAddress, `member at index ${index}`),
    timestamp
  };
}

function normalizeAddress(value: string, label: string): string {
  try {
    return getAddress(value).toLowerCase();
  } catch (cause) {
    throw new Error(`Invalid ${label} address: ${value}`, {cause});
  }
}

function normalizePageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error(`Affiliate RPC page size must be an integer in [1, 1000], received ${value}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
