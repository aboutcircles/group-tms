import {getAddress} from "ethers";
import {ILoggerService} from "../interfaces/ILoggerService";

export const DEFAULT_TRUST_SCORE_URL =
  "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/scoring/relative_trustscore";
export const DEFAULT_TRUST_SCORE_TIMEOUT_MS = 90_000;
export const DEFAULT_TRUST_SCORE_BATCH_SIZE = 100;

const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 2_000;

type RelativeTrustScoreEntry = {
  address?: string;
  relative_score?: number | string;
};

type RelativeTrustScoreResponse = {
  status?: string;
  results?: RelativeTrustScoreEntry[];
};

/**
 * Fetches relative trust scores for the given addresses in batches.
 * Returns scores keyed by lowercase address.
 */
export async function fetchTrustScores(
  scoringUrl: string,
  addresses: string[],
  batchSize: number,
  timeoutMs: number,
  logger: ILoggerService
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const batches = chunkArray(addresses, Math.max(1, batchSize));

  for (const [index, batch] of batches.entries()) {
    logger.debug(`Requesting relative trust scores for batch ${index + 1}/${batches.length} (${batch.length} address(es)).`);
    const batchScores = await fetchScoreBatchWithRetry(scoringUrl, batch, timeoutMs, logger);
    for (const [address, score] of batchScores.entries()) {
      scores.set(address, score);
    }
  }

  return scores;
}

async function fetchScoreBatchWithRetry(
  scoringUrl: string,
  addresses: string[],
  timeoutMs: number,
  logger: ILoggerService
): Promise<Map<string, number>> {
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchScoreBatch(scoringUrl, addresses, timeoutMs);
    } catch (error) {
      if (attempt >= FETCH_MAX_ATTEMPTS || !isRetryableFetchError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Trust score request attempt ${attempt} failed (${message}). Retrying in ${FETCH_RETRY_DELAY_MS} ms.`
      );
      await wait(FETCH_RETRY_DELAY_MS);
    }
  }

  /* istanbul ignore next */
  throw new Error("Failed to fetch trust scores after retries.");
}

async function fetchScoreBatch(
  scoringUrl: string,
  addresses: string[],
  timeoutMs: number
): Promise<Map<string, number>> {
  const avatars = uniqueNormalizedAddresses(addresses);
  const response = await timedFetch(
    scoringUrl,
    {
      method: "POST",
      headers: {
        "accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({avatars, include_details: false})
    },
    timeoutMs
  );

  if (!response.ok) {
    void response.body?.cancel();
    const err = new Error(`Trust score request failed: HTTP ${response.status} ${response.statusText}`);
    if (response.status >= 500) {
      (err as any).code = "SERVER_ERROR";
    }
    throw err;
  }

  const payload = await response.json();
  const results = parseTrustScorePayload(payload);
  if (!results) {
    throw new Error("Trust score response malformed: expected {status: \"success\", results: [...]}.");
  }

  return results;
}

function parseTrustScorePayload(payload: unknown): Map<string, number> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const scorePayload = payload as RelativeTrustScoreResponse;
  if (scorePayload.status !== "success" || !Array.isArray(scorePayload.results)) {
    return null;
  }

  const results = new Map<string, number>();

  for (const entry of scorePayload.results) {
    if (!entry || typeof entry !== "object" || typeof entry.address !== "string") {
      continue;
    }

    const normalized = normalizeAddressToLowercase(entry.address);
    if (!normalized) {
      continue;
    }

    const rawScore = typeof entry.relative_score === "number"
      ? entry.relative_score
      : Number(entry.relative_score);

    if (!Number.isFinite(rawScore)) {
      continue;
    }

    results.set(normalized, rawScore);
  }

  return results;
}

function uniqueNormalizedAddresses(addresses: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const address of addresses) {
    try {
      const normalized = getAddress(address.trim());
      const lower = normalized.toLowerCase();
      if (seen.has(lower)) {
        continue;
      }
      seen.add(lower);
      result.push(normalized);
    } catch {
      // ignore invalid addresses
    }
  }

  return result;
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function normalizeAddressToLowercase(value: string): string | null {
  try {
    return getAddress(value.trim()).toLowerCase();
  } catch {
    return null;
  }
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {...init, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableFetchError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return true;
  }

  const anyError = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof anyError.name === "string" ? anyError.name.toLowerCase() : "";
  const code = typeof anyError.code === "string" ? anyError.code.toUpperCase() : "";
  const message = typeof anyError.message === "string" ? anyError.message.toLowerCase() : "";

  if (code.includes("TIMEOUT") || code.includes("NETWORK") || code.includes("SERVER")) {
    return true;
  }

  if (name === "aborterror") {
    return true;
  }

  if (message.includes("timeout") || message.includes("network") || message.includes("econnreset") || message.includes("temporarily")) {
    return true;
  }

  return false;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export const __testables = {
  fetchScoreBatch,
  parseTrustScorePayload,
  isRetryableFetchError,
  uniqueNormalizedAddresses
};
