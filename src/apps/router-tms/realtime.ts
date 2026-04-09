import {parseRpcSubscriptionMessage, type CirclesEvent, type RpcSubscriptionEvent} from "@aboutcircles/sdk-rpc";
import {getAddress} from "ethers";

import {ILoggerService} from "../../interfaces/ILoggerService";

type StartRegisterHumanListenerOptions = {
  httpRpcUrl: string;
  wsUrl: string;
  logger: ILoggerService;
  onHumansRegistered: (avatars: string[]) => Promise<void> | void;
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

export type RegisterHumanCursor = {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
};

export type RegisterHumanEvent = {
  avatar: string;
  cursor: RegisterHumanCursor;
};

export type QueryFilterPredicate = {
  Type: "FilterPredicate";
  FilterType: "Equals" | "GreaterThan" | "LessThanOrEquals";
  Column: string;
  Value: string | number;
};

export type QueryConjunction = {
  Type: "Conjunction";
  ConjunctionType: "And" | "Or";
  Predicates: Array<QueryFilterPredicate | QueryConjunction>;
};

export type CirclesQueryResponse = {
  columns?: string[];
  rows?: unknown[][];
};

export type RegisterHumanListenerHandle = {
  stop: () => void;
};

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_RECONNECT_BASE_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const DEFAULT_CATCHUP_PAGE_SIZE = 1_000;
const WebSocketImpl = (globalThis as any).WebSocket as { new(url: string): WebSocketLike };

export function startRegisterHumanListener(options: StartRegisterHumanListenerOptions): RegisterHumanListenerHandle {
  const {
    httpRpcUrl,
    wsUrl,
    logger,
    onHumansRegistered,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS
  } = options;

  let stopped = false;
  let ws: WebSocketLike | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let lastSeenCursor: RegisterHumanCursor | null = null;
  const pendingHumans = new Set<string>();

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

  const flushPendingHumans = async (): Promise<void> => {
    clearFlushTimer();
    if (pendingHumans.size === 0) {
      return;
    }

    const avatars = Array.from(pendingHumans);
    pendingHumans.clear();

    try {
      await onHumansRegistered(avatars);
    } catch (error) {
      logger.error("RegisterHuman listener callback failed:", error);
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return;
    }

    flushTimer = setTimeout(() => {
      void flushPendingHumans();
    }, debounceMs);
  };

  const scheduleReconnect = (reason: string): void => {
    if (stopped || reconnectTimer) {
      return;
    }

    const delay = Math.min(reconnectBaseMs * (2 ** reconnectAttempt), reconnectMaxMs);
    reconnectAttempt += 1;

    logger.warn(`RegisterHuman listener disconnected (${reason}); reconnecting in ${delay}ms.`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
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

  const handleRegisterHumanEvents = (events: RegisterHumanEvent[]): void => {
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      pendingHumans.add(event.avatar);
      lastSeenCursor = maxCursor(lastSeenCursor, event.cursor);
    }

    logger.info(`RegisterHuman listener received ${events.length} avatar(s); scheduling realtime routing check.`);
    scheduleFlush();
  };

  const handleSubscriptionPayload = (payload: unknown): void => {
    const events = extractRegisterHumanEventsFromSubscriptionResult(payload);
    if (events.length === 0) {
      return;
    }

    handleRegisterHumanEvents(events);
  };

  const connect = (): void => {
    if (stopped) {
      return;
    }

    clearReconnectTimer();
    closeSocket();

    logger.info(`Connecting RegisterHuman listener to ${wsUrl}...`);
    ws = new WebSocketImpl(wsUrl);
    let connectStartedHead: number | null = null;

    void fetchCurrentBlockNumber(httpRpcUrl)
      .then((head) => {
        connectStartedHead = head;
      })
      .catch((error) => {
        logger.warn("RegisterHuman listener failed to fetch the current block before subscribing:", error);
      });

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      logger.info("RegisterHuman listener connected. Subscribing to Circles events...");
      ws?.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["circles", "{}"]
      }));
    });

    ws.addEventListener("message", (event: WebSocketMessageEventLike) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(String(event.data)) as JsonRpcMessage;
      } catch (error) {
        logger.warn("RegisterHuman listener received invalid JSON payload:", error);
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          logger.error(
            `RegisterHuman listener subscription failed: ${message.error.message ?? "unknown error"}`
          );
          closeSocket();
          scheduleReconnect("subscription failed");
          return;
        }

        logger.info(`RegisterHuman listener subscribed successfully (id=${String(message.result ?? "")}).`);
        if (!lastSeenCursor && Number.isFinite(connectStartedHead)) {
          lastSeenCursor = makeHeadCursor(connectStartedHead as number);
        }
        void catchUpMissedRegistrations(httpRpcUrl, lastSeenCursor, logger)
          .then(({events, currentHead}) => {
            if (!lastSeenCursor && isFiniteNumber(currentHead)) {
              lastSeenCursor = makeHeadCursor(currentHead);
            }

            if (events.length > 0) {
              logger.info(`RegisterHuman listener recovered ${events.length} avatar(s) via reconnect catch-up.`);
              handleRegisterHumanEvents(events);
            } else if (isFiniteNumber(currentHead)) {
              lastSeenCursor = maxCursor(lastSeenCursor, makeHeadCursor(currentHead));
            }
          })
          .catch((error) => {
            logger.warn("RegisterHuman listener catch-up failed:", error);
          });
        return;
      }

      if (message.method === "eth_subscription") {
        handleSubscriptionPayload(message.params?.result);
      }
    });

    ws.addEventListener("error", (event: unknown) => {
      logger.warn("RegisterHuman listener websocket error:", event);
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

export function deriveRegisterHumanWsUrl(rpcUrl: string): string {
  const trimmed = rpcUrl.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }

  const url = new URL(trimmed);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/ws";
  }

  return url.toString();
}

export function extractRegisterHumanAvatarsFromSubscriptionResult(payload: unknown): string[] {
  return Array.from(new Set(
    extractRegisterHumanEventsFromSubscriptionResult(payload).map((event) => event.avatar)
  ));
}

function isRegisterHumanEvent(event: CirclesEvent): boolean {
  const eventName = typeof event.$event === "string" ? String(event.$event) : "";
  return eventName === "CrcV2_RegisterHuman" || eventName === "RegisterHuman";
}

function normalizeRegisteredHumanAvatar(event: CirclesEvent): string | undefined {
  const candidate = getStringProperty(event, "avatar") ?? getStringProperty(event, "human");
  if (!candidate) {
    return undefined;
  }

  try {
    return getAddress(candidate).toLowerCase();
  } catch {
    return undefined;
  }
}

function getStringProperty(event: CirclesEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractRegisterHumanEventsFromSubscriptionResult(payload: unknown): RegisterHumanEvent[] {
  const rpcEvents = Array.isArray(payload)
    ? payload as RpcSubscriptionEvent[]
    : payload
      ? [payload as RpcSubscriptionEvent]
      : [];

  const parsedEvents = parseRpcSubscriptionMessage(rpcEvents);
  const events: RegisterHumanEvent[] = [];

  for (const event of parsedEvents) {
    if (!isRegisterHumanEvent(event)) {
      continue;
    }

    const avatar = normalizeRegisteredHumanAvatar(event);
    const cursor = getCursorFromEvent(event);
    if (avatar && cursor) {
      events.push({avatar, cursor});
    }
  }

  return dedupeRegisterHumanEvents(events);
}

async function catchUpMissedRegistrations(
  httpRpcUrl: string,
  cursor: RegisterHumanCursor | null,
  logger: ILoggerService
): Promise<{events: RegisterHumanEvent[]; currentHead: number | null}> {
  const currentHead = await fetchCurrentBlockNumber(httpRpcUrl);
  if (!cursor) {
    return {events: [], currentHead};
  }

  if (!isFiniteNumber(currentHead) || currentHead <= cursor.blockNumber) {
    return {events: [], currentHead};
  }

  logger.info(
    `RegisterHuman listener catch-up: querying from block ${cursor.blockNumber} ` +
      `tx ${cursor.transactionIndex} log ${cursor.logIndex} up to block ${currentHead}.`
  );

  const events = await fetchRegisterHumanEventsBetween(httpRpcUrl, cursor, currentHead);
  return {events, currentHead};
}

async function fetchCurrentBlockNumber(httpRpcUrl: string): Promise<number | null> {
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

  if (typeof payload.result === "number" && Number.isFinite(payload.result)) {
    return payload.result;
  }

  if (typeof payload.result === "string") {
    const parsed = payload.result.startsWith("0x")
      ? Number.parseInt(payload.result, 16)
      : Number.parseInt(payload.result, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

async function fetchRegisterHumanEventsBetween(
  httpRpcUrl: string,
  cursor: RegisterHumanCursor,
  toBlock: number
): Promise<RegisterHumanEvent[]> {
  let currentCursor = cursor;
  const events: RegisterHumanEvent[] = [];

  while (currentCursor.blockNumber <= toBlock) {
    const response = await fetch(httpRpcUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "circles_query",
        params: [{
          Namespace: "CrcV2",
          Table: "RegisterHuman",
          Columns: ["avatar", "blockNumber", "transactionIndex", "logIndex"],
          Filter: [buildRegisterHumanCatchUpFilter(currentCursor, toBlock)],
          Order: [
            {Column: "blockNumber", SortOrder: "ASC"},
            {Column: "transactionIndex", SortOrder: "ASC"},
            {Column: "logIndex", SortOrder: "ASC"}
          ],
          Limit: DEFAULT_CATCHUP_PAGE_SIZE
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`circles_query failed with HTTP ${response.status}.`);
    }

    const payload = await response.json() as {result?: CirclesQueryResponse; error?: {message?: string}};
    if (payload.error) {
      throw new Error(payload.error.message ?? "circles_query returned an RPC error.");
    }

    const page = extractRegisterHumanEventsFromQueryResponse(payload.result);
    if (page.length === 0) {
      break;
    }

    events.push(...page);
    currentCursor = maxCursor(currentCursor, page[page.length - 1].cursor) ?? currentCursor;

    if (page.length < DEFAULT_CATCHUP_PAGE_SIZE) {
      break;
    }
  }

  return dedupeRegisterHumanEvents(events);
}

export function buildRegisterHumanCatchUpFilter(cursor: RegisterHumanCursor, toBlock: number): QueryConjunction {
  return {
    Type: "Conjunction",
    ConjunctionType: "And",
    Predicates: [
      {
        Type: "Conjunction",
        ConjunctionType: "Or",
        Predicates: [
          {
            Type: "FilterPredicate",
            FilterType: "GreaterThan",
            Column: "blockNumber",
            Value: cursor.blockNumber
          },
          {
            Type: "Conjunction",
            ConjunctionType: "And",
            Predicates: [
              equalPredicate("blockNumber", cursor.blockNumber),
              greaterThanPredicate("transactionIndex", cursor.transactionIndex)
            ]
          },
          {
            Type: "Conjunction",
            ConjunctionType: "And",
            Predicates: [
              equalPredicate("blockNumber", cursor.blockNumber),
              equalPredicate("transactionIndex", cursor.transactionIndex),
              greaterThanPredicate("logIndex", cursor.logIndex)
            ]
          }
        ]
      },
      {
        Type: "FilterPredicate",
        FilterType: "LessThanOrEquals",
        Column: "blockNumber",
        Value: toBlock
      }
    ]
  };
}

export function extractRegisterHumanEventsFromQueryResponse(result: CirclesQueryResponse | undefined): RegisterHumanEvent[] {
  const columns = Array.isArray(result?.columns) ? result?.columns : [];
  const rows = Array.isArray(result?.rows) ? result?.rows : [];
  const avatarIndex = columns.indexOf("avatar");
  const blockNumberIndex = columns.indexOf("blockNumber");
  const transactionIndexIndex = columns.indexOf("transactionIndex");
  const logIndexIndex = columns.indexOf("logIndex");

  if (avatarIndex < 0 || blockNumberIndex < 0 || transactionIndexIndex < 0 || logIndexIndex < 0) {
    return [];
  }

  const events: RegisterHumanEvent[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }

    const avatarValue = row[avatarIndex];
    const blockNumber = toFiniteNumber(row[blockNumberIndex]);
    const transactionIndex = toFiniteNumber(row[transactionIndexIndex]);
    const logIndex = toFiniteNumber(row[logIndexIndex]);
    if (typeof avatarValue !== "string" || blockNumber === null || transactionIndex === null || logIndex === null) {
      continue;
    }

    try {
      events.push({
        avatar: getAddress(avatarValue).toLowerCase(),
        cursor: {blockNumber, transactionIndex, logIndex}
      });
    } catch {
      // Skip malformed rows from the RPC.
    }
  }

  return dedupeRegisterHumanEvents(events);
}

function equalPredicate(column: string, value: number): QueryFilterPredicate {
  return {
    Type: "FilterPredicate",
    FilterType: "Equals",
    Column: column,
    Value: value
  };
}

function greaterThanPredicate(column: string, value: number): QueryFilterPredicate {
  return {
    Type: "FilterPredicate",
    FilterType: "GreaterThan",
    Column: column,
    Value: value
  };
}

function makeHeadCursor(blockNumber: number): RegisterHumanCursor {
  return {
    blockNumber,
    transactionIndex: Number.MAX_SAFE_INTEGER,
    logIndex: Number.MAX_SAFE_INTEGER
  };
}

function getCursorFromEvent(event: CirclesEvent): RegisterHumanCursor | undefined {
  if (!Number.isFinite(event.blockNumber) || !Number.isFinite(event.transactionIndex) || !Number.isFinite(event.logIndex)) {
    return undefined;
  }

  return {
    blockNumber: event.blockNumber,
    transactionIndex: event.transactionIndex,
    logIndex: event.logIndex
  };
}

function maxCursor(
  left: RegisterHumanCursor | null,
  right: RegisterHumanCursor | null
): RegisterHumanCursor | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return compareCursor(left, right) >= 0 ? left : right;
}

function compareCursor(left: RegisterHumanCursor, right: RegisterHumanCursor): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber - right.blockNumber;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

function dedupeRegisterHumanEvents(events: RegisterHumanEvent[]): RegisterHumanEvent[] {
  const deduped: RegisterHumanEvent[] = [];
  const seen = new Set<string>();

  for (const event of events.sort((left, right) => compareCursor(left.cursor, right.cursor))) {
    const key = `${event.avatar}:${event.cursor.blockNumber}:${event.cursor.transactionIndex}:${event.cursor.logIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
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

function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}
