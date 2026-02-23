import {CirclesData, CirclesRpc} from "@circles-sdk/data";
import {Address} from "@circles-sdk/utils";
import {CrcV2_CirclesBackingCompleted, CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";
import {getAddress, Interface, JsonRpcProvider} from "ethers";
import {ICirclesRpc} from "../interfaces/ICirclesRpc";

const CIRCLES_HUB_ADDRESS = getAddress("0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8");
const CIRCLES_HUB_INTERFACE = new Interface([
  "function isHuman(address account) view returns (bool)"
]);

// TODO: Replace unwrapEventsResult + flattenRawEvent with @aboutcircles/sdk-rpc
// QueryMethods.events() once sdk-v2 feature/new_rpc_methods is merged & published.
// That branch has the correct signature (address, fromBlock, toBlock, eventTypes,
// filterPredicates, ...) and returns typed PagedEventsResponse<T> directly.
// See: https://github.com/aboutcircles/sdk-v2/tree/feature/new_rpc_methods

/**
 * Extract events from a circles_events RPC paginated response
 * and normalise raw events into the flat SDK shape.
 */
function unwrapEventsResult(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result.map(flattenRawEvent);
  }

  if (!result || typeof result !== "object" || !("events" in result)) {
    return [];
  }

  const events = (result as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return [];
  }

  return events.map(flattenRawEvent);
}

const NUMERIC_FIELDS = new Set(["blockNumber", "timestamp", "transactionIndex", "logIndex"]);

/**
 * Flatten a raw RPC event from {event, values: {field1, field2, ...}}
 * to the SDK shape {$event, field1, field2, ...}.
 * Hex-encoded numeric fields (blockNumber, timestamp, etc.) are parsed to numbers.
 */
function flattenRawEvent(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;

  // Already in SDK shape (has $event) — pass through
  if ("$event" in obj) return obj;

  // Raw RPC shape: {event: "CrcV2_...", values: {...}}
  if ("event" in obj && "values" in obj && typeof obj.values === "object" && obj.values) {
    const values = obj.values as Record<string, unknown>;
    const flat: Record<string, unknown> = { $event: obj.event };
    for (const [key, val] of Object.entries(values)) {
      if (NUMERIC_FIELDS.has(key) && typeof val === "string" && val.startsWith("0x")) {
        flat[key] = parseInt(val, 16);
      } else {
        flat[key] = val;
      }
    }
    return flat;
  }

  return raw;
}

export class CirclesRpcService implements ICirclesRpc {
  private readonly provider: JsonRpcProvider;

  constructor(private rpcUrl: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
  }

  async isHuman(address: string): Promise<boolean> {
    const normalized = getAddress(address);
    const data = CIRCLES_HUB_INTERFACE.encodeFunctionData("isHuman", [normalized]);
    const result = await this.provider.call({
      to: CIRCLES_HUB_ADDRESS,
      data
    });

    const [isHuman] = CIRCLES_HUB_INTERFACE.decodeFunctionResult("isHuman", result);
    return Boolean(isHuman);
  }

  async fetchAllTrustees(truster: string): Promise<string[]> {
    const trusterLc = truster.toLowerCase();
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    const trustRelationsQuery = data.getTrustRelations(truster as Address, 1000);
    const allTrustees: string[] = [];

    while (await trustRelationsQuery.queryNextPage()) {
      trustRelationsQuery
        .currentPage?.results
        .filter(o => o.truster.toLowerCase() === trusterLc)
        .map(o => o.trustee.toLowerCase())
        .forEach(o => allTrustees.push(o))
    }

    return allTrustees;
  }

  async fetchBackingCompletedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingCompleted[]> {
    const rpc = new CirclesRpc(this.rpcUrl);
    const response = await rpc.call<unknown>("circles_events", [
      undefined, fromBlock, toBlock,
      ["CrcV2_CirclesBackingCompleted"],
      [{ Type: "FilterPredicate", FilterType: "Equals", Column: "emitter", Value: backingFactoryAddress }]
    ]);
    return unwrapEventsResult(response.result) as CrcV2_CirclesBackingCompleted[];
  }

  async fetchBackingInitiatedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingInitiated[]> {
    const rpc = new CirclesRpc(this.rpcUrl);
    const response = await rpc.call<unknown>("circles_events", [
      undefined, fromBlock, toBlock,
      ["CrcV2_CirclesBackingInitiated"],
      [{ Type: "FilterPredicate", FilterType: "Equals", Column: "emitter", Value: backingFactoryAddress }]
    ]);
    return unwrapEventsResult(response.result) as CrcV2_CirclesBackingInitiated[];
  }

  async fetchAllBaseGroups(pageSize: number = 1000): Promise<string[]> {
    const limit = Math.max(1, pageSize);
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    const query = data.findGroups(limit, {
      groupTypeIn: ["CrcV2_BaseGroupCreated"]
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
}

export const __testables = {
  unwrapEventsResult,
  flattenRawEvent
};
