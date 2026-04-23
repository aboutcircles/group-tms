import {CirclesRpc, PagedQuery} from "@aboutcircles/sdk-rpc";
import {getAddress} from "ethers";
import {ICirclesRpc, BackingCompletedEvent, BackingInitiatedEvent} from "../interfaces/ICirclesRpc";
import {ILoggerService} from "../interfaces/ILoggerService";
import {primaryRpcUrl} from "./rpcProvider";

const PAGE_DELAY_MS = Math.max(50, Number(process.env.CIRCLES_RPC_PAGE_DELAY_MS) || 100);
const MAX_PAGES = 500;
const PAGE_TIMEOUT_MS = 30_000;
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

export class CirclesRpcService implements ICirclesRpc {
  private readonly rpc: CirclesRpc;

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
    const query = this.rpc.trust.getTrustRelations(trusterLc, 1000);
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

    return allTrustees;
  }

  /**
   * Workaround: sdk-rpc v0.1.24 sends circles_events params in wrong order.
   * Uses raw client.call with correct param order: [address, fromBlock, toBlock, eventTypes, filterPredicates].
   * Backing events aren't emitted by the factory — they're emitted by individual
   * backing instances, so we query all events and filter by emitter column.
   */
  private async fetchEvents<T>(
    emitterAddress: string,
    fromBlock: number,
    toBlock: number | null,
    eventTypes: string[],
  ): Promise<T[]> {
    const result = await this.rpc.client.call("circles_events", [
      undefined, fromBlock, toBlock, eventTypes,
      [{ Type: "FilterPredicate", FilterType: "Equals", Column: "emitter", Value: emitterAddress }],
    ]);
    return (result as any)?.events?.map((e: any) => {
      const extra = Object.fromEntries(
        Object.entries(e.values ?? {}).filter(
          ([k]) => !["blockNumber", "timestamp", "transactionIndex", "logIndex", "transactionHash"].includes(k)
        )
      );
      return {
        ...extra,
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
      };
    }) ?? [];
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

    if (skipped > 0) {
      logger?.warn(`Skipped ${skipped} invalid avatar address(es) from RPC.`);
    }
    logger?.info(`Fetched ${avatars.length} avatars from RegisterHuman table across ${pages} page(s).`);
    return avatars;
  }
}
