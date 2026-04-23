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
];

const TRANSIENT_CODES = new Set<number>([-32016]);

export function isTransientRpcError(err: unknown): boolean {
  if (err == null) return false;
  const msg = String((err as any)?.message ?? err);
  const code = ((err as any)?.code ?? (err as any)?.error?.code) as number | undefined;

  if (code !== undefined && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_MESSAGES.some((t) => msg.includes(t));
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Execute `fn` with exponential backoff on transient RPC errors.
 * Non-transient errors are thrown immediately.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientRpcError(err) || attempt >= maxRetries) {
        throw err;
      }
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable, but satisfies TypeScript
  throw lastError;
}
