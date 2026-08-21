import {mapPacedChunks} from "../../src/services/pacedChunks";

const noRetry = <T>(fn: () => Promise<T>): Promise<T> => fn();

describe("mapPacedChunks", () => {
  it("splits into chunks of the requested size and preserves order", async () => {
    const seen: number[][] = [];
    const results = await mapPacedChunks(
      [1, 2, 3, 4, 5],
      {chunkSize: 2, delayMs: 0, run: noRetry},
      async (chunk) => {
        seen.push(chunk);
        return chunk.length;
      }
    );

    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
    expect(results).toEqual([2, 2, 1]);
  });

  it("sleeps between chunks but not after the last one", async () => {
    const sleeps: number[] = [];
    await mapPacedChunks(
      [1, 2, 3, 4, 5],
      {chunkSize: 2, delayMs: 300, run: noRetry, sleep: async (ms) => { sleeps.push(ms); }},
      async () => undefined
    );

    // 3 chunks -> 2 gaps. A trailing sleep would be pure latency for no benefit.
    expect(sleeps).toEqual([300, 300]);
  });

  it("takes no gap at all for a single chunk", async () => {
    const sleeps: number[] = [];
    await mapPacedChunks(
      [1, 2],
      {chunkSize: 25, delayMs: 300, run: noRetry, sleep: async (ms) => { sleeps.push(ms); }},
      async () => undefined
    );

    expect(sleeps).toEqual([]);
  });

  it("runs chunks strictly sequentially", async () => {
    const events: string[] = [];
    await mapPacedChunks(
      [1, 2, 3, 4],
      {chunkSize: 2, delayMs: 0, run: noRetry},
      async (chunk) => {
        events.push(`start:${chunk[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push(`end:${chunk[0]}`);
      }
    );

    expect(events).toEqual(["start:1", "end:1", "start:3", "end:3"]);
  });

  it("routes every chunk through the retry wrapper", async () => {
    let runCalls = 0;
    const run = <T>(fn: () => Promise<T>): Promise<T> => {
      runCalls += 1;
      return fn();
    };
    await mapPacedChunks([1, 2, 3], {chunkSize: 1, delayMs: 0, run}, async () => undefined);

    expect(runCalls).toBe(3);
  });

  it("retries a chunk that fails with a wrapped 429, using the real retry wrapper", async () => {
    let attempts = 0;
    const results = await mapPacedChunks([1, 2], {chunkSize: 2, delayMs: 0}, async (chunk) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Failed to connect to RPC endpoint", {
          cause: new Error("HTTP 429: Too Many Requests")
        });
      }
      return chunk.length;
    });

    expect(attempts).toBe(2);
    expect(results).toEqual([2]);
  });

  it("propagates a chunk failure and stops processing", async () => {
    const seen: number[][] = [];
    await expect(
      mapPacedChunks([1, 2, 3, 4], {chunkSize: 2, delayMs: 0, run: noRetry}, async (chunk) => {
        seen.push(chunk);
        if (chunk[0] === 1) throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(seen).toEqual([[1, 2]]);
  });

  it("does nothing for an empty input", async () => {
    const fn = jest.fn(async () => undefined);
    const results = await mapPacedChunks([], {chunkSize: 25, delayMs: 300, run: noRetry}, fn);

    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("clamps a non-positive chunk size to 1 instead of looping forever", async () => {
    const seen: number[][] = [];
    await mapPacedChunks([1, 2], {chunkSize: 0, delayMs: 0, run: noRetry}, async (chunk) => {
      seen.push(chunk);
    });

    expect(seen).toEqual([[1], [2]]);
  });

  it("clamps a negative delay to no sleep", async () => {
    const sleep = jest.fn(async () => undefined);
    await mapPacedChunks([1, 2, 3], {chunkSize: 1, delayMs: -5, run: noRetry, sleep}, async () => undefined);

    expect(sleep).not.toHaveBeenCalled();
  });
});
