import {FallbackProvider, Interface, JsonRpcProvider, Log} from "ethers";

import {ILoggerService} from "../../interfaces/ILoggerService";
import {createProvider} from "../../services/rpcProvider";
import {retryWithBackoff} from "../../services/retryWithBackoff";

/** NEW multi-affiliate registry (MultiAffiliateGroupRegistry). */
export const DEFAULT_MULTI_AFFILIATE_REGISTRY_ADDRESS =
  "0x4a25a7cf216351963f1637ad965d77b3ae277ef3";
/** Registry deploy block — start of the event history. */
export const DEFAULT_MULTI_AFFILIATE_REGISTRY_DEPLOY_BLOCK = 46891940;

const ABI = [
  "event AffiliateGroupAdded(address affiliateGroup, address avatar)",
  "event AffiliateGroupRemoved(address affiliateGroup, address avatar)"
] as const;
const IFACE = new Interface(ABI);
export const AFFILIATE_GROUP_ADDED_TOPIC0 =
  IFACE.getEvent("AffiliateGroupAdded")!.topicHash.toLowerCase();
export const AFFILIATE_GROUP_REMOVED_TOPIC0 =
  IFACE.getEvent("AffiliateGroupRemoved")!.topicHash.toLowerCase();

const DEFAULT_LOG_CHUNK_SIZE = 100_000;
const DEFAULT_RECONNECT_BASE_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 1_000;
const WebSocketImpl = (globalThis as unknown as {WebSocket: {new(url: string): WebSocketLike}}).WebSocket;

export type MultiAffiliateEvent = {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  txHash: string;
  type: "add" | "remove";
  avatar: string;
  group: string;
};

/**
 * Chunked `eth_getLogs` history/incremental fetch for both registry events,
 * returned in on-chain order (block, txIndex, logIndex). Used for the boot
 * backfill and per-cycle incremental catch-up.
 */
export async function fetchMultiAffiliateEvents(
  rpcUrl: string,
  registryAddress: string,
  fromBlock: number,
  toBlock: number,
  logger?: ILoggerService,
  chunkSize = DEFAULT_LOG_CHUNK_SIZE
): Promise<MultiAffiliateEvent[]> {
  if (fromBlock > toBlock) return [];

  const provider = createProvider(rpcUrl) as JsonRpcProvider | FallbackProvider;
  const events: MultiAffiliateEvent[] = [];
  let chunkStart = Math.max(0, fromBlock);
  try {
    while (chunkStart <= toBlock) {
      const chunkEnd = Math.min(toBlock, chunkStart + chunkSize - 1);
      const logs = await retryWithBackoff(() =>
        provider.getLogs({
          address: registryAddress,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          topics: [[AFFILIATE_GROUP_ADDED_TOPIC0, AFFILIATE_GROUP_REMOVED_TOPIC0]]
        })
      );
      logger?.info(`[multi-registry-fetch] range=${chunkStart}-${chunkEnd} logs=${logs.length}`);
      for (const log of logs) {
        const parsed = parseLog(fromEthersLog(log), registryAddress);
        if (parsed) events.push(parsed);
      }
      chunkStart = chunkEnd + 1;
    }
  } finally {
    provider.destroy();
  }
  return sortEvents(events);
}

type EthLogLike = {
  address?: string;
  topics?: unknown[];
  data?: string;
  blockNumber?: string | number;
  transactionHash?: string;
  transactionIndex?: string | number;
  logIndex?: string | number;
};

type WebSocketLike = {
  addEventListener: (type: string, listener: (event: any) => void) => void;
  send: (data: string) => void;
  close: () => void;
};

export type MultiAffiliateListenerHandle = {stop: () => void};

/**
 * WSS `eth_subscribe(logs)` listener for both registry events, keeping an
 * in-memory map current between poll cycles. On (re)connect it runs a getLogs
 * catch-up from `getFromBlock()` so no event is missed across disconnects.
 * Faithful to group-affiliates' realtime listener (backoff reconnect, debounce),
 * adapted for two non-indexed events.
 */
export function startMultiAffiliateListener(options: {
  httpRpcUrl: string;
  wsUrl: string;
  registryAddress: string;
  logger: ILoggerService;
  getFromBlock: () => number;
  onEvents: (events: MultiAffiliateEvent[]) => Promise<void> | void;
  debounceMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}): MultiAffiliateListenerHandle {
  const {
    httpRpcUrl, wsUrl, registryAddress, logger, getFromBlock, onEvents,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS
  } = options;

  let stopped = false;
  let ws: WebSocketLike | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let catchUpInFlight = false;
  const pending: MultiAffiliateEvent[] = [];

  const clearReconnect = (): void => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  const closeSocket = (): void => {
    if (!ws) return;
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  };
  const scheduleReconnect = (reason: string): void => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(reconnectBaseMs * (2 ** reconnectAttempt), reconnectMaxMs);
    reconnectAttempt += 1;
    logger.warn(`Multi-affiliate listener disconnected (${reason}); reconnecting in ${delay}ms.`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };

  const deliver = async (events: MultiAffiliateEvent[]): Promise<void> => {
    if (events.length === 0) return;
    try {
      await onEvents(sortEvents(events));
    } catch (error) {
      logger.error("Multi-affiliate listener callback failed:", error);
    }
  };
  const flush = async (): Promise<void> => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending.length === 0) return;
    await deliver(pending.splice(0, pending.length));
  };
  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { void flush(); }, debounceMs);
  };

  const catchUp = async (): Promise<void> => {
    if (catchUpInFlight) return;
    catchUpInFlight = true;
    try {
      const head = await fetchHeadBlock(httpRpcUrl);
      const from = getFromBlock();
      if (head === null || head < from) return;
      const events = await fetchMultiAffiliateEvents(httpRpcUrl, registryAddress, from, head, logger);
      await deliver(events);
    } catch (error) {
      logger.warn("Multi-affiliate listener catch-up failed:", error);
    } finally {
      catchUpInFlight = false;
    }
  };

  const connect = (): void => {
    if (stopped) return;
    clearReconnect();
    closeSocket();
    logger.info(`Connecting multi-affiliate listener to ${wsUrl}...`);
    ws = new WebSocketImpl(wsUrl);

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      ws?.send(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_subscribe",
        params: ["logs", {address: registryAddress, topics: [[AFFILIATE_GROUP_ADDED_TOPIC0, AFFILIATE_GROUP_REMOVED_TOPIC0]]}]
      }));
    });

    ws.addEventListener("message", (event: {data: unknown}) => {
      let message: {id?: number; method?: string; error?: {message?: string}; params?: {result?: unknown}};
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          logger.error(`Multi-affiliate subscription failed: ${message.error.message ?? "unknown"}`);
          closeSocket();
          scheduleReconnect("subscription failed");
          return;
        }
        void catchUp();
        return;
      }
      if (message.method === "eth_subscription") {
        const raw = message.params?.result;
        const logs = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const log of logs as EthLogLike[]) {
          const parsed = parseLog(log, registryAddress);
          if (parsed) pending.push(parsed);
        }
        if (pending.length > 0) scheduleFlush();
      }
    });

    ws.addEventListener("error", (e: unknown) => logger.warn("Multi-affiliate listener websocket error:", e));
    ws.addEventListener("close", (e: {code: number}) => {
      ws = null;
      if (!stopped) scheduleReconnect(`close code ${e.code}`);
    });
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      clearReconnect();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      closeSocket();
    }
  };
}

export function deriveWsUrl(rpcUrl: string): string {
  const trimmed = rpcUrl.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  const url = new URL(trimmed);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (!url.pathname || url.pathname === "/") url.pathname = "/ws/chain";
  return url.toString();
}

async function fetchHeadBlock(httpRpcUrl: string): Promise<number | null> {
  const response = await fetch(httpRpcUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: []})
  });
  if (!response.ok) throw new Error(`eth_blockNumber failed with HTTP ${response.status}`);
  const payload = await response.json() as {result?: string | number; error?: {message?: string}};
  if (payload.error) throw new Error(payload.error.message ?? "eth_blockNumber RPC error");
  return toNumber(payload.result);
}

function parseLog(log: EthLogLike, registryAddress?: string): MultiAffiliateEvent | null {
  if (registryAddress && typeof log.address === "string" &&
      log.address.toLowerCase() !== registryAddress.toLowerCase()) {
    return null;
  }
  const topics = Array.isArray(log.topics)
    ? log.topics.filter((t): t is string => typeof t === "string")
    : [];
  if (topics.length === 0 || typeof log.data !== "string") return null;
  const topic0 = topics[0].toLowerCase();
  const type: "add" | "remove" | null =
    topic0 === AFFILIATE_GROUP_ADDED_TOPIC0 ? "add"
      : topic0 === AFFILIATE_GROUP_REMOVED_TOPIC0 ? "remove"
        : null;
  if (!type) return null;

  let parsed;
  try {
    parsed = IFACE.parseLog({topics, data: log.data});
  } catch {
    return null;
  }
  const blockNumber = toNumber(log.blockNumber);
  const transactionIndex = toNumber(log.transactionIndex);
  const logIndex = toNumber(log.logIndex);
  if (!parsed || blockNumber === null || transactionIndex === null || logIndex === null || !log.transactionHash) {
    return null;
  }
  return {
    blockNumber,
    transactionIndex,
    logIndex,
    txHash: log.transactionHash,
    type,
    avatar: String(parsed.args.avatar),
    group: String(parsed.args.affiliateGroup)
  };
}

function fromEthersLog(log: Log): EthLogLike {
  return {
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.index
  };
}

function sortEvents(events: MultiAffiliateEvent[]): MultiAffiliateEvent[] {
  const seen = new Set<string>();
  const deduped: MultiAffiliateEvent[] = [];
  for (const event of events) {
    const key = `${event.txHash}:${event.blockNumber}:${event.transactionIndex}:${event.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped.sort((a, b) =>
    a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex
  );
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
