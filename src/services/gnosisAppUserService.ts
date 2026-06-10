import {getAddress} from "ethers";
import {ILoggerService} from "../interfaces/ILoggerService";

export const DEFAULT_GNOSIS_APP_INDEXER_URL = "https://gnosis-e702590.dedicated.hyperindex.xyz/v1/graphql";
export const DEFAULT_GNOSIS_APP_FETCH_PAGE_SIZE = 1_000;
export const DEFAULT_GNOSIS_APP_FETCH_TIMEOUT_MS = 60_000;
const MAX_INDEXER_PAGE_SIZE = 1_000;

export type GraphQLFetcher = (query: string) => Promise<unknown>;

export async function fetchRegisterHumanGnosisAppUserAddresses(
  indexerUrl: string,
  pageSize: number,
  timeoutMs: number,
  fromBlock: number | undefined,
  logger: ILoggerService
): Promise<string[]> {
  const fetcher = (query: string) => defaultGraphQLFetcher(indexerUrl, query, timeoutMs);
  const userIds = await fetchAllGnosisAppUserIds(fetcher, indexerUrl, pageSize, fromBlock, logger);
  const registerHumanIds = await filterRegisterHumanAvatars(fetcher, userIds, pageSize, logger);
  const skipped = userIds.length - registerHumanIds.length;

  logger.info(
    `Gnosis App users${fromBlock === undefined ? "" : ` after block ${fromBlock}`}: ${userIds.length} total, ` +
    `${registerHumanIds.length} RegisterHuman, ${skipped} Unclaimed/non-RegisterHuman.`
  );

  return registerHumanIds;
}

async function fetchAllGnosisAppUserIds(
  fetcher: GraphQLFetcher,
  indexerUrl: string,
  pageSize: number,
  fromBlock: number | undefined,
  logger: ILoggerService
): Promise<string[]> {
  const result: string[] = [];
  const limit = normalizePageSize(pageSize);
  let offset = 0;
  const hardPageCap = 1_000;

  for (let page = 0; page < hardPageCap; page += 1) {
    const where = fromBlock === undefined ? "" : `where:{createdAtBlock:{_gt:${fromBlock}}}, `;
    const query =
      `{ GnosisAppUser(${where}order_by:{createdAtBlock:asc}, limit:${limit}, offset:${offset})` +
      "{ id createdAtBlock } }";
    logger.debug(`Querying ${indexerUrl} GnosisAppUser page=${page} offset=${offset} limit=${limit}`);
    const payload = await fetcher(query);
    const batch = parseGnosisAppUserIds(payload);
    result.push(...batch);

    if (batch.length < limit) {
      return result;
    }

    offset += limit;
  }

  logger.warn(`GnosisAppUser pagination cap reached; returning ${result.length} user id(s) so far.`);
  return result;
}

async function filterRegisterHumanAvatars(
  fetcher: GraphQLFetcher,
  userIds: string[],
  pageSize: number,
  logger: ILoggerService
): Promise<string[]> {
  const normalizedUserIds = uniqueChecksumAddresses(userIds, logger);
  const result: string[] = [];
  const chunkSize = normalizePageSize(pageSize);

  for (const chunk of chunkArray(normalizedUserIds, chunkSize)) {
    const ids = chunk.map((id) => JSON.stringify(id)).join(",");
    const query =
      `{ Avatar(where:{id:{_in:[${ids}]}, avatarType:{_eq:"RegisterHuman"}})` +
      "{ id avatarType } }";
    const payload = await fetcher(query);
    result.push(...parseAvatarIds(payload));
  }

  return uniqueNormalizedAddresses(result, logger);
}

async function defaultGraphQLFetcher(
  indexerUrl: string,
  query: string,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(indexerUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({query}),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gnosis App indexer request failed: HTTP ${response.status} ${response.statusText} ${text}`);
    }

    const payload = await response.json();
    const errors = (payload as {errors?: unknown}).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`Gnosis App indexer GraphQL error: ${JSON.stringify(errors)}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function parseGnosisAppUserIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = (payload as {data?: {GnosisAppUser?: unknown}}).data;
  const raw = data?.GnosisAppUser;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => entry && typeof entry === "object" ? (entry as {id?: unknown}).id : undefined)
    .filter((id): id is string => typeof id === "string");
}

function parseAvatarIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = (payload as {data?: {Avatar?: unknown}}).data;
  const raw = data?.Avatar;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => entry && typeof entry === "object" ? (entry as {id?: unknown}).id : undefined)
    .filter((id): id is string => typeof id === "string");
}

function uniqueNormalizedAddresses(addresses: string[], logger: ILoggerService): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const address of addresses) {
    try {
      const normalized = getAddress(address).toLowerCase();
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      result.push(normalized);
    } catch {
      skipped += 1;
    }
  }

  if (skipped > 0) {
    logger.warn(`Skipped ${skipped} invalid Gnosis App user address(es).`);
  }

  return result;
}

function uniqueChecksumAddresses(addresses: string[], logger: ILoggerService): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const address of addresses) {
    try {
      const checksum = getAddress(address);
      const lower = checksum.toLowerCase();
      if (seen.has(lower)) {
        continue;
      }

      seen.add(lower);
      result.push(checksum);
    } catch {
      skipped += 1;
    }
  }

  if (skipped > 0) {
    logger.warn(`Skipped ${skipped} invalid Gnosis App user address(es).`);
  }

  return result;
}

function normalizePageSize(pageSize: number): number {
  return Math.min(Math.max(1, pageSize), MAX_INDEXER_PAGE_SIZE);
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

export const __testables = {
  chunkArray,
  fetchAllGnosisAppUserIds,
  filterRegisterHumanAvatars,
  normalizePageSize,
  parseAvatarIds,
  parseGnosisAppUserIds,
  uniqueChecksumAddresses,
  uniqueNormalizedAddresses
};
