import {retryWithBackoff} from "./retryWithBackoff";

/**
 * Sequential chunked iteration with a gap between chunks.
 *
 * Chunking alone does not bound the request rate: an `await`ed loop over chunks
 * that each resolve in a millisecond still issues every chunk inside the same
 * second. Servers that rate-limit per client see that as one burst. The gap is
 * what keeps the sustained rate inside their budget; the retry wrapper is the
 * safety net for whatever still slips through.
 */
export interface PacedChunkOptions {
  /** Items per chunk. Values below 1 are treated as 1. */
  chunkSize: number;
  /** Gap after each chunk except the last. Values below 0 are treated as 0. */
  delayMs: number;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to retryWithBackoff. */
  run?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Splits `items` into chunks, runs `fn` on each one in order, and returns the
 * results in chunk order. No gap is taken after the final chunk, so a single
 * chunk costs nothing extra.
 */
export async function mapPacedChunks<TItem, TResult>(
  items: readonly TItem[],
  opts: PacedChunkOptions,
  fn: (chunk: TItem[]) => Promise<TResult>
): Promise<TResult[]> {
  const chunkSize = Math.max(1, Math.floor(opts.chunkSize));
  const delayMs = Math.max(0, opts.delayMs);
  const sleep = opts.sleep ?? defaultSleep;
  const run = opts.run ?? ((task) => retryWithBackoff(task));

  const results: TResult[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize) as TItem[];
    results.push(await run(() => fn(chunk)));

    const isLastChunk = i + chunkSize >= items.length;
    if (!isLastChunk && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}
