import {__testables} from "../../../src/apps/gnosis-group/logic";

const {timedFetch, isRetryableFetchError} = __testables;

describe("gnosis-group helpers", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("aborts fetch requests that exceed the configured timeout", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    jest.useFakeTimers();
    const fetchPromise = timedFetch("https://scores.local", {method: "POST"}, 1_000);
    const expectation = expect(fetchPromise).rejects.toThrow("aborted");

    await jest.advanceTimersByTimeAsync(1_000);
    await expectation;
  });

  it("classifies retryable fetch errors", () => {
    expect(isRetryableFetchError("temporary issue")).toBe(true);
    expect(isRetryableFetchError({code: "NETWORK_ERROR"})).toBe(true);
    expect(isRetryableFetchError({name: "AbortError"})).toBe(true);
    expect(isRetryableFetchError({message: "network timeout"})).toBe(true);
    expect(isRetryableFetchError({name: "TypeError", code: "NONRETRY", message: "fatal"})).toBe(false);
  });
});
