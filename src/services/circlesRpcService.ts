import {CirclesRpc, PagedQuery} from "@aboutcircles/sdk-rpc";
import {getAddress} from "ethers";
import {ICirclesRpc, BackingCompletedEvent, BackingInitiatedEvent} from "../interfaces/ICirclesRpc";
import {ILoggerService} from "../interfaces/ILoggerService";
import {primaryRpcUrl} from "./rpcProvider";

const CIRCLES_EVENTS_RESULT_LIMIT = 100;
const DEFAULT_TRUST_QUERY_PAGE_SIZE = 1000;

export type BulkTrusteesForTrustersStats = {
  pagesFetched: number;
  rowsScanned: number;
};

export class CirclesRpcService implements ICirclesRpc {
  private readonly rpc: CirclesRpc;
  private lastBulkTrusteesForTrustersStats: BulkTrusteesForTrustersStats = {
    pagesFetched: 0,
    rowsScanned: 0
  };

  constructor(rpcUrl: string) {
    this.rpc = new CirclesRpc(primaryRpcUrl(rpcUrl));
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

    while (await query.queryNextPage()) {
      const rows = query.currentPage?.results ?? [];
      for (const row of rows) {
        if (row.truster.toLowerCase() === trusterLc) {
          allTrustees.push(row.trustee.toLowerCase());
        }
      }
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

    while (await query.queryNextPage()) {
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

    while (await query.queryNextPage()) {
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
    return rawEvents.map((e: any) => ({
      $event: e.event,
      blockNumber: typeof e.values?.blockNumber === "string"
        ? parseInt(e.values.blockNumber, 16) : e.values?.blockNumber,
      timestamp: typeof e.values?.timestamp === "string"
        ? parseInt(e.values.timestamp, 16) : e.values?.timestamp,
      transactionIndex: typeof e.values?.transactionIndex === "string"
        ? parseInt(e.values.transactionIndex, 16) : e.values?.transactionIndex,
      logIndex: typeof e.values?.logIndex === "string"
        ? parseInt(e.values.logIndex, 16) : e.values?.logIndex,
      transactionHash: e.values?.transactionHash,
      ...Object.fromEntries(
        Object.entries(e.values ?? {}).filter(
          ([k]) => !["blockNumber", "timestamp", "transactionIndex", "logIndex", "transactionHash"].includes(k)
        )
      ),
    })) as T[];
  }

  private async fetchEventsRecursive<T>(
    emitterAddress: string,
    fromBlock: number,
    toBlock: number,
    eventTypes: string[],
  ): Promise<T[]> {
    const rawEvents = await this.fetchEventsPage(emitterAddress, fromBlock, toBlock, eventTypes);
    if (rawEvents.length < CIRCLES_EVENTS_RESULT_LIMIT || fromBlock >= toBlock) {
      return this.mapEvents<T>(rawEvents);
    }

    const midpoint = Math.floor((fromBlock + toBlock) / 2);
    if (midpoint < fromBlock || midpoint >= toBlock) {
      return this.mapEvents<T>(rawEvents);
    }

    const [left, right] = await Promise.all([
      this.fetchEventsRecursive<T>(emitterAddress, fromBlock, midpoint, eventTypes),
      this.fetchEventsRecursive<T>(emitterAddress, midpoint + 1, toBlock, eventTypes),
    ]);

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
    while (await query.queryNextPage()) {
      const rows = query.currentPage?.results ?? [];
      for (const row of rows) {
        if (typeof row.group === "string" && row.group.length > 0) {
          groups.add(row.group);
        }
      }
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

    while (await query.queryNextPage()) {
      pages++;
      const rows = query.currentPage?.results ?? [];
      for (const row of rows) {
        if (row && typeof row.avatar === "string") {
          try {
            avatars.push(getAddress(row.avatar).toLowerCase());
          } catch {
            // skip invalid addresses
          }
        }
      }
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
