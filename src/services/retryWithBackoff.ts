/**
 * Shared retry utility for transient RPC errors with exponential backoff.
 */

/** Known transient RPC error patterns that are safe to retry. */
const TRANSIENT_MESSAGES = [
  "timeout",
  "canceled",
  "cancelled",
  "ECONNRESET",
  "ECONNREFUSED",
  "socket hang up",
  "Too Many Requests",
  "evm timeout",
];

const TRANSIENT_CODES = new Set<number>([
  -32016, // Nethermind internal timeout/overload
  -32009, // Gnosis RPC "evm timeout" during gas estimation
  429,    // HTTP 429 Too Many Requests (rate limit)
]);

/** Match "429" only as a standalone token, not inside larger numbers like "42900001". */
const RATE_LIMIT_PATTERN = /\b429\b/;

export function isTransientRpcError(err: unknown): boolean {
  if (err == null) return false;
  const msg = String((err as any)?.message ?? err);
  const code = ((err as any)?.code ?? (err as any)?.error?.code) as number | undefined;
  const status = ((err as any)?.status ?? (err as any)?.statusCode) as number | undefined;

  if (code !== undefined && TRANSIENT_CODES.has(code)) return true;
  if (status !== undefined && TRANSIENT_CODES.has(status)) return true;
  if (RATE_LIMIT_PATTERN.test(msg)) return true;

  // ethers CALL_EXCEPTION with data strictly null/undefined = RPC failed to simulate
  // (returned no revert payload at all). data="0x" means a real bare revert() — not transient.
  // Caveat: some RPCs omit revert data even for genuine reverts. This is a best-effort heuristic.
  const ethersCode = (err as any)?.code as string | undefined;
  if (ethersCode === "CALL_EXCEPTION") {
    const d = (err as any)?.data;
    if (d === null || d === undefined) return true;
  }

  return TRANSIENT_MESSAGES.some((t) => msg.includes(t));
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Execute `fn` with exponential backoff + jitter on transient RPC errors.
 * Non-transient errors are thrown immediately.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1_000;
  const maxDelayMs = opts?.maxDelayMs ?? Number.POSITIVE_INFINITY;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientRpcError(err) || attempt >= maxRetries) {
        throw err;
      }
      // Jitter: 50-100% of base delay to avoid thundering herd across workers
      const jitter = 0.5 + Math.random() * 0.5;
      const backoffDelayMs = Math.round(baseDelayMs * Math.pow(2, attempt) * jitter);
      const retryAfterMs = parseRetryAfterMs(err);
      const delayMs = Math.min(maxDelayMs, Math.max(backoffDelayMs, retryAfterMs ?? 0));
      const errMsg = formatRetryError(err);
      console.warn(`[RPC_RETRY] attempt ${attempt + 1}/${maxRetries}, waiting ${delayMs}ms — ${errMsg}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable, but satisfies TypeScript
  throw lastError;
}

function parseRetryAfterMs(err: unknown): number | undefined {
  const value = (err as {retryAfterMs?: unknown} | null | undefined)?.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.ceil(value)
    : undefined;
}

function formatRetryError(err: unknown): string {
  if (err == null) {
    return "unknown error";
  }

  const anyErr = err as any;
  const code = anyErr?.code;
  const action = anyErr?.action;
  const reason = anyErr?.reason;
  const data = anyErr?.data;

  if (code || action || reason || data !== undefined) {
    const parts = [
      code ? `code=${String(code)}` : undefined,
      action ? `action=${String(action)}` : undefined,
      reason ? `reason=${String(reason)}` : undefined,
      data === null ? "data=null" : data === "0x" ? "data=0x" : undefined
    ].filter(Boolean);

    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  const msg = String(anyErr?.message ?? err);
  return msg.length > 500 ? `${msg.slice(0, 500)}...` : msg;
}
