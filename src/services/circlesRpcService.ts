import {CirclesRpc, PagedQuery} from "@aboutcircles/sdk-rpc";
import {getAddress} from "ethers";
import {ICirclesRpc, BackingCompletedEvent, BackingInitiatedEvent} from "../interfaces/ICirclesRpc";
import {ILoggerService} from "../interfaces/ILoggerService";
import {primaryRpcUrl} from "./rpcProvider";

const PAGE_DELAY_MS = Math.max(50, Number(process.env.CIRCLES_RPC_PAGE_DELAY_MS) || 100);
const MAX_PAGES = 500;
const PAGE_TIMEOUT_MS = 30_000;
const CIRCLES_EVENTS_RESULT_LIMIT = 100;
const DEFAULT_TRUST_QUERY_PAGE_SIZE = 1000;
const MAX_EVENT_RECURSION_DEPTH = 10;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC page request timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export type BulkTrusteesForTrustersStats = {
  pagesFetched: number;
  rowsScanned: number;
};

export class CirclesRpcService implements ICirclesRpc {
  private readonly rpc: CirclesRpc;
  private readonly onWarning: (msg: string) => void;
  private lastBulkTrusteesForTrustersStats: BulkTrusteesForTrustersStats = {
    pagesFetched: 0,
    rowsScanned: 0
  };

  constructor(rpcUrl: string, onWarning?: (msg: string) => void) {
    this.rpc = new CirclesRpc(primaryRpcUrl(rpcUrl));
    this.onWarning = onWarning ?? ((msg) => console.warn(`[CirclesRpc] ${msg}`));
  }

  async isHuman(address: string): Promise<boolean> {
    const normalized = getAddress(address).toLowerCase();
    const info = await this.rpc.avatar.getAvatarInfo(normalized);
    return info?.isHuman === true;
  }

  async isHumanBatch(addresses: string[]): Promise<Map<string, boolean>> {
    const normalized = addresses.map((a) => getAddress(a).toLowerCase());
    const infos = await this.rpc.avatar.getAvatarInfoBatch(normalized);
    const result = new Map<string, boolean>();
    for (const info of infos) {
      result.set(info.avatar.toLowerCase(), info.isHuman === true);
    }
    for (const addr of normalized) {
      if (!result.has(addr)) result.set(addr, false);
    }
    return result;
  }

  async fetchAllTrustees(truster: string): Promise<string[]> {
    const trusterLc = truster.toLowerCase();
    const query = this.rpc.trust.getTrustRelations(trusterLc, DEFAULT_TRUST_QUERY_PAGE_SIZE);
    const allTrustees: string[] = [];
    let pages = 0;

    while (pages < MAX_PAGES && await withTimeout(query.queryNextPage(), PAGE_TIMEOUT_MS)) {
      pages++;
      const rows = query.currentPage?.results ?? [];
      for (const row of rows) {
        if (row.truster.toLowerCase() === trusterLc) {
          allTrustees.push(row.trustee.toLowerCase());
        }
      }
      await delay(PAGE_DELAY_MS);
    }
    if (pages >= MAX_PAGES) {
      this.onWarning(`fetchAllTrustees for ${trusterLc}: hit ${MAX_PAGES}-page cap — result may be truncated`);
    }

    return allTrustees;
  }

  async fetchAllTrusteesForTrusters(
    trusters: string[],
    pageSize: number = DEFAULT_TRUST_QUERY_PAGE_SIZE
  ): Promise<Map<string, string[]>> {
    const normalizedTrusters = Array.from(new Set(trusters.map((truster) => truster.toLowerCase())));
    const trusteesByTruster = new Map<string, string[]>();
    normalizedTrusters.forEach((truster) => trusteesByTruster.set(truster, []));

    this.lastBulkTrusteesForTrustersStats = {
      pagesFetched: 0,
      rowsScanned: 0
    };

    if (normalizedTrusters.length === 0) {
      return trusteesByTruster;
    }

    const query = new PagedQuery<{
      truster: string;
      trustee: string;
    }>(this.rpc.client, {
      namespace: "V_Crc",
      table: "TrustRelations",
      sortOrder: "DESC",
      columns: [
        "blockNumber",
        "timestamp",
        "transactionIndex",
        "logIndex",
        "transactionHash",
        "version",
        "trustee",
        "truster",
        "expiryTime"
      ],
      filter: [{
        Type: "Conjunction",
        ConjunctionType: "And",
        Predicates: [
          {
            Type: "FilterPredicate",
            FilterType: "Equals",
            Column: "version",
            Value: 2
          },
          {
            Type: "Conjunction",
            ConjunctionType: "Or",
            Predicates: normalizedTrusters.map((truster) => ({
              Type: "FilterPredicate" as const,
              FilterType: "Equals" as const,
              Column: "truster",
              Value: truster
            }))
          }
        ]
      }],
      limit: pageSize
    });

    while (this.lastBulkTrusteesForTrustersStats.pagesFetched < MAX_PAGES && await withTimeout(query.queryNextPage(), PAGE_TIMEOUT_MS)) {
      this.lastBulkTrusteesForTrustersStats.pagesFetched += 1;
      const rows = query.currentPage?.results ?? [];
      this.lastBulkTrusteesForTrustersStats.rowsScanned += rows.length;

      for (const row of rows) {
        if (typeof row.truster !== "string" || typeof row.trustee !== "string") {
          continue;
        }

        const normalizedTruster = row.truster.toLowerCase();
        if (!trusteesByTruster.has(normalizedTruster)) {
          continue;
        }

        trusteesByTruster.get(normalizedTruster)?.push(row.trustee.toLowerCase());
      }
      await delay(PAGE_DELAY_MS);
    }
    if (this.lastBulkTrusteesForTrustersStats.pagesFetched >= MAX_PAGES) {
      this.onWarning(`fetchAllTrusteesForTrusters: hit ${MAX_PAGES}-page cap — result may be truncated (${normalizedTrusters.length} trusters)`);
    }

    return trusteesByTruster;
  }

  getLastBulkTrusteesForTrustersStats(): BulkTrusteesForTrustersStats {
    return this.lastBulkTrusteesForTrustersStats;
  }

  async fetchActiveGroupMembersAtBlock(groupAddress: string, blockNumber: number): Promise<string[]> {
    const normalizedGroupAddress = getAddress(groupAddress).toLowerCase();
    const blockTimestamp = await this.fetchBlockTimestamp(blockNumber);
    const query = new PagedQuery<{
      member: string;
      expiryTime: string;
    }>(this.rpc.client, {
      namespace: "V_CrcV2",
      table: "GroupMemberships",
      sortOrder: "DESC",
      columns: ["member", "expiryTime", "blockNumber", "transactionIndex", "logIndex"],
      filter: [{
        Type: "Conjunction",
        ConjunctionType: "And",
        Predicates: [
          {Type: "FilterPredicate", FilterType: "Equals", Column: "group", Value: normalizedGroupAddress},
          {
            Type: "FilterPredicate",
            FilterType: "LessThanOrEquals" as unknown as "LessOrEqualThan",
            Column: "blockNumber",
            Value: blockNumber
          }
        ]
      }],
      limit: 1000
    });

    const members: string[] = [];
    const seen = new Set<string>();
    const blockTimestampBigInt = BigInt(blockTimestamp);
    let pages = 0;

    while (pages < MAX_PAGES && await withTimeout(query.queryNextPage(), PAGE_TIMEOUT_MS)) {
      pages++;
      const rows = query.currentPage?.results ?? [];
      for (const row of rows) {
        if (typeof row.member !== "string" || typeof row.expiryTime !== "string") {
          continue;
        }

        let normalizedMember: string;
        try {
          normalizedMember = getAddress(row.member).toLowerCase();
        } catch {
          continue;
        }

        let expiryTime: bigint;
        try {
          expiryTime = BigInt(row.expiryTime);
        } catch {
          continue;
        }

        if (expiryTime <= blockTimestampBigInt || seen.has(normalizedMember)) {
          continue;
        }

        seen.add(normalizedMember);
        members.push(normalizedMember);
      }
      await delay(PAGE_DELAY_MS);
    }
    if (pages >= MAX_PAGES) {
      this.onWarning(`fetchActiveGroupMembersAtBlock for ${normalizedGroupAddress} at block ${blockNumber}: hit ${MAX_PAGES}-page cap — result may be truncated`);
    }

    return members;
  }

  /**
   * Workaround: sdk-rpc v0.1.24 sends circles_events params in wrong order.
   * Uses raw client.call with correct param order:
   * [address, fromBlock, toBlock, eventTypes, filterPredicates].
   *
   * The RPC currently returns a bare array for circles_events, but older mocks
   * and wrappers may still expose an { events } object. Accept both shapes.
   */
  private async fetchEventsPage(
    emitterAddress: string,
    fromBlock: number,
    toBlock: number,
    eventTypes: string[],
  ): Promise<any[]> {
    const result = await this.rpc.client.call("circles_events", [
      undefined, fromBlock, toBlock, eventTypes,
      [{ Type: "FilterPredicate", FilterType: "Equals", Column: "emitter", Value: emitterAddress }],
    ]);

    return Array.isArray(result)
      ? result
      : Array.isArray((result as any)?.events)
        ? (result as any).events
        : [];
  }

  private mapEvents<T>(rawEvents: any[]): T[] {
    return rawEvents.map((e: any) => {
      const extra = Object.fromEntries(
        Object.entries(e.values ?? {}).filter(
          ([k]) => !["blockNumber", "timestamp", "transactionIndex", "logIndex", "transactionHash"].includes(k)
        )
      );
      const parseHex = (val: unknown): number | undefined => {
        if (typeof val === "number") return Number.isFinite(val) ? val : undefined;
        if (typeof val !== "string") return undefined;
        const parsed = parseInt(val, 16);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      return {
        ...extra,
        $event: e.event,
        blockNumber: parseHex(e.values?.blockNumber),
        timestamp: parseHex(e.values?.timestamp),
        transactionIndex: parseHex(e.values?.transactionIndex),
        logIndex: parseHex(e.values?.logIndex),
        transactionHash: e.values?.transactionHash,
      };
    }) as T[];
  }

  private async fetchEventsRecursive<T>(
    emitterAddress: string,
    fromBlock: number,
    toBlock: number,
    eventTypes: string[],
    depth: number = 0,
  ): Promise<T[]> {
    const rawEvents = await withTimeout(
      this.fetchEventsPage(emitterAddress, fromBlock, toBlock, eventTypes),
      PAGE_TIMEOUT_MS
    );
    if (rawEvents.length < CIRCLES_EVENTS_RESULT_LIMIT || fromBlock >= toBlock) {
      return this.mapEvents<T>(rawEvents);
    }
    if (depth >= MAX_EVENT_RECURSION_DEPTH) {
      this.onWarning(`fetchEventsRecursive: hit depth cap (${MAX_EVENT_RECURSION_DEPTH}) with ${rawEvents.length} events in range [${fromBlock}, ${toBlock}] — events beyond the first ${CIRCLES_EVENTS_RESULT_LIMIT} in this range are LOST`);
      return this.mapEvents<T>(rawEvents);
    }

    const midpoint = Math.floor((fromBlock + toBlock) / 2);
    if (midpoint < fromBlock || midpoint >= toBlock) {
      return this.mapEvents<T>(rawEvents);
    }

    // Sequential to avoid 429 amplification from geometric parallel expansion
    await delay(PAGE_DELAY_MS);
    const left = await this.fetchEventsRecursive<T>(emitterAddress, fromBlock, midpoint, eventTypes, depth + 1);
    await delay(PAGE_DELAY_MS);
    const right = await this.fetchEventsRecursive<T>(emitterAddress, midpoint + 1, toBlock, eventTypes, depth + 1);

    return [...left, ...right];
  }

  private sortEventsDescending<T extends {
    blockNumber: number;
    transactionIndex: number;
    logIndex: number;
  }>(events: T[]): T[] {
    return events.sort((a, b) => (
      b.blockNumber - a.blockNumber ||
      b.transactionIndex - a.transactionIndex ||
      b.logIndex - a.logIndex
    ));
  }

  private async fetchHeadBlockNumber(): Promise<number> {
    const head = await this.rpc.client.call("eth_blockNumber", []) as string | number | null;
    if (typeof head === "number" && Number.isFinite(head)) {
      return head;
    }

    if (typeof head === "string") {
      const parsed = head.startsWith("0x")
        ? Number.parseInt(head, 16)
        : Number.parseInt(head, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    throw new Error("Unable to fetch current head block number.");
  }

  private async fetchEvents<T extends {
    blockNumber: number;
    transactionIndex: number;
    logIndex: number;
  }>(
    emitterAddress: string,
    fromBlock: number,
    toBlock: number | null,
    eventTypes: string[],
  ): Promise<T[]> {
    const resolvedToBlock = toBlock ?? await this.fetchHeadBlockNumber();
    if (resolvedToBlock < fromBlock) {
      return [];
    }

    const events = await this.fetchEventsRecursive<T>(
      emitterAddress,
      fromBlock,
      resolvedToBlock,
      eventTypes,
    );

    return this.sortEventsDescending(events);
  }

  async fetchBackingCompletedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<BackingCompletedEvent[]> {
    return this.fetchEvents<BackingCompletedEvent>(
      backingFactoryAddress, fromBlock, toBlock ?? null, ["CrcV2_CirclesBackingCompleted"],
    );
  }

  async fetchBackingInitiatedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<BackingInitiatedEvent[]> {
    return this.fetchEvents<BackingInitiatedEvent>(
      backingFactoryAddress, fromBlock, toBlock ?? null, ["CrcV2_CirclesBackingInitiated"],
    );
  }

  async fetchAllBaseGroups(pageSize: number = 1000): Promise<string[]> {
    const query = this.rpc.group.getGroups(pageSize, {
      groupTypeIn: ["CrcV2_BaseGroupCreated"],
    });

    const groups = new Set<string>();
    let pages = 0;
    while (pages < MAX_PAGES && await withTimeout(query.queryNextPage(), PAGE_TIMEOUT_MS)) {
      pages++;
      const rows = query.currentPage?.results ?? [];
      for (const row of rows) {
        if (typeof row.group === "string" && row.group.length > 0) {
          groups.add(row.group.toLowerCase());
        }
      }
      await delay(PAGE_DELAY_MS);
    }
    if (pages >= MAX_PAGES) {
      this.onWarning(`fetchAllBaseGroups: hit ${MAX_PAGES}-page cap — result may be truncated`);
    }

    return Array.from(groups);
  }

  async fetchAllHumanAvatars(pageSize: number = 1000, logger?: ILoggerService): Promise<string[]> {
    const query = new PagedQuery<{ avatar: string }>(this.rpc.client, {
      namespace: "CrcV2",
      table: "RegisterHuman",
      columns: ["avatar", "blockNumber", "transactionIndex", "logIndex"],
      sortOrder: "ASC",
      limit: pageSize,
    });

    const avatars: string[] = [];
    let pages = 0;
    let skipped = 0;

    while (pages < MAX_PAGES && await withTimeout(query.queryNextPage(), PAGE_TIMEOUT_MS)) {
      pages++;
      const rows = query.currentPage?.results ?? [];
      for (const row of rows) {
        if (row && typeof row.avatar === "string") {
          try {
            avatars.push(getAddress(row.avatar).toLowerCase());
          } catch {
            skipped++;
          }
        }
      }
      await delay(PAGE_DELAY_MS);
    }

    if (pages >= MAX_PAGES) {
      const msg = `fetchAllHumanAvatars: hit ${MAX_PAGES}-page cap — result may be truncated (${avatars.length} avatars so far)`;
      this.onWarning(msg);
    }
    if (skipped > 0) {
      logger?.warn(`Skipped ${skipped} invalid avatar address(es) from RPC.`);
    }
    logger?.info(`Fetched ${avatars.length} avatars from RegisterHuman table across ${pages} page(s).`);
    return avatars;
  }

  private async fetchBlockTimestamp(blockNumber: number): Promise<number> {
    const hexBlockNumber = `0x${blockNumber.toString(16)}`;
    const block = await this.rpc.client.call("eth_getBlockByNumber", [hexBlockNumber, false]) as {
      timestamp?: string | number;
    } | null;

    if (!block || block.timestamp === undefined) {
      throw new Error(`Unable to fetch timestamp for block ${blockNumber}.`);
    }

    if (typeof block.timestamp === "number" && Number.isFinite(block.timestamp)) {
      return block.timestamp;
    }

    if (typeof block.timestamp === "string") {
      const parsed = block.timestamp.startsWith("0x")
        ? Number.parseInt(block.timestamp, 16)
        : Number.parseInt(block.timestamp, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    throw new Error(`Unable to parse timestamp for block ${blockNumber}.`);
  }
}
