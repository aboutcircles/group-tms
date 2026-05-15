import {FallbackProvider, Interface, JsonRpcProvider, Log} from "ethers";

import {ILoggerService} from "../../interfaces/ILoggerService";
import {createProvider} from "../../services/rpcProvider";
import {retryWithBackoff} from "../../services/retryWithBackoff";

export type EventCursor = {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
};

export type AffiliateGroupChangedWithCursor = {
  blockNumber: number;
  txHash: string;
  human: string;
  oldGroup: string;
  newGroup: string;
  cursor: EventCursor;
};

type StartAffiliateGroupChangedListenerOptions = {
  httpRpcUrl: string;
  wsUrl: string;
  registryAddress: string;
  logger: ILoggerService;
  startCursor: EventCursor | null;
  onEvents: (events: AffiliateGroupChangedWithCursor[]) => Promise<boolean> | boolean;
  debounceMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: {
    subscription?: string;
    result?: unknown;
  };
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type EthLogSubscriptionEvent = {
  address?: string;
  topics?: unknown[];
  data?: string;
  blockNumber?: string | number;
  transactionHash?: string;
  transactionIndex?: string | number;
  logIndex?: string | number;
};

type WebSocketMessageEventLike = {
  data: unknown;
};

type WebSocketCloseEventLike = {
  code: number;
};

type WebSocketLike = {
  addEventListener: (type: string, listener: (event: any) => void) => void;
  send: (data: string) => void;
  close: () => void;
};

export type AffiliateGroupChangedListenerHandle = {
  stop: () => void;
};

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_RECONNECT_BASE_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const DEFAULT_LOG_CHUNK_SIZE = 100_000;
const WebSocketImpl = (globalThis as any).WebSocket as { new(url: string): WebSocketLike };

export const AFFILIATE_GROUP_CHANGED_ABI = [
  "event AffiliateGroupChanged(address indexed human, address oldGroup, address newGroup)"
] as const;

const AFFILIATE_GROUP_CHANGED_IFACE = new Interface(AFFILIATE_GROUP_CHANGED_ABI);
export const AFFILIATE_GROUP_CHANGED_TOPIC0 =
  AFFILIATE_GROUP_CHANGED_IFACE.getEvent("AffiliateGroupChanged")!.topicHash.toLowerCase();

export function startAffiliateGroupChangedListener(
  options: StartAffiliateGroupChangedListenerOptions
): AffiliateGroupChangedListenerHandle {
  const {
    httpRpcUrl,
    wsUrl,
    registryAddress,
    logger,
    onEvents,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS
  } = options;

  let stopped = false;
  let ws: WebSocketLike | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let lastSeenCursor = options.startCursor;
  let catchUpInFlight: Promise<void> | null = null;
  const pendingEvents: AffiliateGroupChangedWithCursor[] = [];
  const subscriptionRequest = buildAffiliateGroupChangedSubscriptionRequest(registryAddress);

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearFlushTimer = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const deliverEvents = async (events: AffiliateGroupChangedWithCursor[]): Promise<void> => {
    const filtered = filterEventsAfterCursor(events, lastSeenCursor);
    if (filtered.length === 0) {
      return;
    }

    try {
      const shouldAdvance = await onEvents(filtered);
      if (shouldAdvance) {
        lastSeenCursor = maxCursor(lastSeenCursor, filtered[filtered.length - 1].cursor);
      }
    } catch (error) {
      logger.error("AffiliateGroupChanged listener callback failed:", error);
    }
  };

  const flushPendingEvents = async (): Promise<void> => {
    clearFlushTimer();
    if (pendingEvents.length === 0) {
      return;
    }

    const events = pendingEvents.splice(0, pendingEvents.length);
    await deliverEvents(events);
  };

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      void flushPendingEvents();
    }, debounceMs);
  };

  const closeSocket = (): void => {
    if (!ws) {
      return;
    }
    try {
      ws.close();
    } catch {
      // Ignore close errors during shutdown/reconnect.
    }
    ws = null;
  };

  const scheduleReconnect = (reason: string): void => {
    if (stopped || reconnectTimer) {
      return;
    }

    const delay = Math.min(reconnectBaseMs * (2 ** reconnectAttempt), reconnectMaxMs);
    reconnectAttempt += 1;
    logger.warn(`AffiliateGroupChanged listener disconnected (${reason}); reconnecting in ${delay}ms.`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const runCatchUp = async (connectStartedHead: number | null): Promise<void> => {
    if (catchUpInFlight) {
      return catchUpInFlight;
    }

    catchUpInFlight = (async () => {
      try {
        const currentHead = connectStartedHead ?? await fetchCurrentBlockNumber(httpRpcUrl);
        if (!Number.isFinite(currentHead)) {
          return;
        }

        if (!lastSeenCursor) {
          lastSeenCursor = makeHeadCursor(currentHead as number);
          return;
        }

        if ((currentHead as number) < lastSeenCursor.blockNumber) {
          return;
        }

        const events = await fetchAffiliateGroupChangedEventsBetween(
          httpRpcUrl,
          registryAddress,
          lastSeenCursor.blockNumber,
          currentHead as number,
          lastSeenCursor,
          logger
        );
        await deliverEvents(events);
      } catch (error) {
        logger.warn("AffiliateGroupChanged listener catch-up failed:", error);
      } finally {
        catchUpInFlight = null;
      }
    })();

    return catchUpInFlight;
  };

  const handleSubscriptionPayload = (payload: unknown): void => {
    const events = extractAffiliateGroupChangedEventsFromSubscriptionPayload(payload, registryAddress);
    if (events.length === 0) {
      return;
    }

    pendingEvents.push(...events);
    logger.info(`AffiliateGroupChanged listener detected ${events.length} event(s).`);
    scheduleFlush();
  };

  const connect = (): void => {
    if (stopped) {
      return;
    }

    clearReconnectTimer();
    closeSocket();

    logger.info(`Connecting AffiliateGroupChanged listener to ${wsUrl}...`);
    ws = new WebSocketImpl(wsUrl);
    let connectStartedHead: number | null = null;

    void fetchCurrentBlockNumber(httpRpcUrl)
      .then((head) => {
        connectStartedHead = head;
      })
      .catch((error) => {
        logger.warn("AffiliateGroupChanged listener failed to fetch current block before subscribing:", error);
      });

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      logger.info("AffiliateGroupChanged listener connected. Subscribing to chain logs...");
      ws?.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: subscriptionRequest.params
      }));
    });

    ws.addEventListener("message", (event: WebSocketMessageEventLike) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(String(event.data)) as JsonRpcMessage;
      } catch (error) {
        logger.warn("AffiliateGroupChanged listener received invalid JSON payload:", error);
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          logger.error(
            `AffiliateGroupChanged listener subscription failed: ${message.error.message ?? "unknown error"}`
          );
          closeSocket();
          scheduleReconnect("subscription failed");
          return;
        }

        logger.info(`AffiliateGroupChanged listener subscribed successfully (id=${String(message.result ?? "")}).`);
        void runCatchUp(connectStartedHead);
        return;
      }

      if (message.method === "eth_subscription") {
        handleSubscriptionPayload(message.params?.result);
      }
    });

    ws.addEventListener("error", (event: unknown) => {
      logger.warn("AffiliateGroupChanged listener websocket error:", event);
    });

    ws.addEventListener("close", (event: WebSocketCloseEventLike) => {
      ws = null;
      if (stopped) {
        return;
      }
      scheduleReconnect(`close code ${event.code}`);
    });
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      clearReconnectTimer();
      clearFlushTimer();
      closeSocket();
    }
  };
}

export function deriveGroupAffiliatesWsUrl(rpcUrl: string): string {
  const trimmed = rpcUrl.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }

  const url = new URL(trimmed);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/ws/chain";
  }
  return url.toString();
}

export function buildAffiliateGroupChangedSubscriptionRequest(registryAddress: string): {
  description: string;
  params: ["logs", {address: string; topics: string[]}];
} {
  return {
    description: "AffiliateGroupChanged chain logs",
    params: ["logs", {
      address: registryAddress,
      topics: [AFFILIATE_GROUP_CHANGED_TOPIC0]
    }]
  };
}

export function extractAffiliateGroupChangedEventsFromSubscriptionPayload(
  payload: unknown,
  registryAddress?: string
): AffiliateGroupChangedWithCursor[] {
  const logs = Array.isArray(payload)
    ? payload as EthLogSubscriptionEvent[]
    : payload
      ? [payload as EthLogSubscriptionEvent]
      : [];

  const events: AffiliateGroupChangedWithCursor[] = [];
  for (const log of logs) {
    const parsed = parseAffiliateGroupChangedLog(log, registryAddress);
    if (parsed) {
      events.push(parsed);
    }
  }
  return dedupeAndSortEvents(events);
}

export async function fetchAffiliateGroupChangedEventsBetween(
  rpcUrl: string,
  registryAddress: string,
  fromBlock: number,
  toBlock: number,
  afterCursor: EventCursor | null = null,
  logger?: ILoggerService,
  chunkSize = DEFAULT_LOG_CHUNK_SIZE
): Promise<AffiliateGroupChangedWithCursor[]> {
  if (fromBlock > toBlock) {
    return [];
  }

  const provider = createProvider(rpcUrl) as JsonRpcProvider | FallbackProvider;
  const events: AffiliateGroupChangedWithCursor[] = [];
  let chunkStart = Math.max(0, fromBlock);
  const totalChunks = Math.ceil((toBlock - chunkStart + 1) / chunkSize);
  let chunkIndex = 0;

  try {
    while (chunkStart <= toBlock) {
      const chunkEnd = Math.min(toBlock, chunkStart + chunkSize - 1);
      chunkIndex += 1;
      const logs = await retryWithBackoff(() =>
        provider.getLogs({
          address: registryAddress,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          topics: [AFFILIATE_GROUP_CHANGED_TOPIC0]
        })
      );

      logger?.info(
        `[group-affiliates-fetch] chunk ${chunkIndex}/${totalChunks} range=${chunkStart}-${chunkEnd} logs=${logs.length}`
      );

      for (const log of logs) {
        const parsed = parseAffiliateGroupChangedLog(fromEthersLog(log), registryAddress);
        if (parsed && (!afterCursor || compareEventCursor(parsed.cursor, afterCursor) > 0)) {
          events.push(parsed);
        }
      }

      chunkStart = chunkEnd + 1;
    }
  } finally {
    provider.destroy();
  }

  return dedupeAndSortEvents(events);
}

export async function fetchCurrentBlockNumber(httpRpcUrl: string): Promise<number | null> {
  const response = await fetch(httpRpcUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: []
    })
  });

  if (!response.ok) {
    throw new Error(`eth_blockNumber failed with HTTP ${response.status}.`);
  }

  const payload = await response.json() as {result?: string | number; error?: {message?: string}};
  if (payload.error) {
    throw new Error(payload.error.message ?? "eth_blockNumber returned an RPC error.");
  }

  return toFiniteNumber(payload.result);
}

export function makeHeadCursor(blockNumber: number): EventCursor {
  return {
    blockNumber,
    transactionIndex: Number.MAX_SAFE_INTEGER,
    logIndex: Number.MAX_SAFE_INTEGER
  };
}

export function makeInclusiveBlockCursor(blockNumber: number): EventCursor {
  return {
    blockNumber,
    transactionIndex: -1,
    logIndex: -1
  };
}

export function compareEventCursor(left: EventCursor, right: EventCursor): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber - right.blockNumber;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

export function maxCursor(left: EventCursor | null, right: EventCursor | null): EventCursor | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return compareEventCursor(left, right) >= 0 ? left : right;
}

export function filterEventsAfterCursor(
  events: AffiliateGroupChangedWithCursor[],
  cursor: EventCursor | null
): AffiliateGroupChangedWithCursor[] {
  return dedupeAndSortEvents(
    cursor
      ? events.filter((event) => compareEventCursor(event.cursor, cursor) > 0)
      : events
  );
}

function parseAffiliateGroupChangedLog(
  log: EthLogSubscriptionEvent,
  registryAddress?: string
): AffiliateGroupChangedWithCursor | null {
  if (registryAddress && typeof log.address === "string" && log.address.toLowerCase() !== registryAddress.toLowerCase()) {
    return null;
  }

  const topics = Array.isArray(log.topics)
    ? log.topics.filter((topic): topic is string => typeof topic === "string")
    : [];
  if (topics.length === 0 || topics[0].toLowerCase() !== AFFILIATE_GROUP_CHANGED_TOPIC0 || typeof log.data !== "string") {
    return null;
  }

  let parsedLog;
  try {
    parsedLog = AFFILIATE_GROUP_CHANGED_IFACE.parseLog({
      topics,
      data: log.data
    });
  } catch {
    return null;
  }

  const blockNumber = toFiniteNumber(log.blockNumber);
  const transactionIndex = toFiniteNumber(log.transactionIndex);
  const logIndex = toFiniteNumber(log.logIndex);
  if (!parsedLog || blockNumber === null || transactionIndex === null || logIndex === null || !log.transactionHash) {
    return null;
  }

  return {
    blockNumber,
    txHash: log.transactionHash,
    human: String(parsedLog.args.human),
    oldGroup: String(parsedLog.args.oldGroup),
    newGroup: String(parsedLog.args.newGroup),
    cursor: {blockNumber, transactionIndex, logIndex}
  };
}

function fromEthersLog(log: Log): EthLogSubscriptionEvent {
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

function dedupeAndSortEvents(events: AffiliateGroupChangedWithCursor[]): AffiliateGroupChangedWithCursor[] {
  const seen = new Set<string>();
  const deduped: AffiliateGroupChangedWithCursor[] = [];

  for (const event of events) {
    const key = `${event.txHash}:${event.cursor.blockNumber}:${event.cursor.transactionIndex}:${event.cursor.logIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }

  return deduped.sort((left, right) => compareEventCursor(left.cursor, right.cursor));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = value.startsWith("0x")
      ? Number.parseInt(value, 16)
      : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
