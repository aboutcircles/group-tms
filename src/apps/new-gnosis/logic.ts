import { getAddress } from "ethers";
import { ILoggerService } from "../../interfaces/ILoggerService";

export type GnosisAppUser = {
  id: string;
  createdAtBlock: number;
  lifetimeCashback?: string | number;
};

export type GraphQLFetcher = (query: string) => Promise<unknown>;

export type ExistingTrusteesFetcher = (contractAddress: string) => Promise<string[]>;

export type RegisteredHumanFilter = (addresses: string[]) => Promise<Set<string>>;

export type IsOptedOutChecker = (addresses: string[]) => Promise<Map<string, boolean>>;

export type TrustBatchExecutor = (
  contractAddress: string,
  avatars: string[]
) => Promise<string>;

export type RunConfig = {
  indexerUrl: string;
  contractAddress: string;
  startBlock: number;
  fetchPageSize: number;
  trustBatchSize: number;
  fetchTimeoutMs: number;
  dryRun: boolean;
};

export type RunDeps = {
  fetchUsers: GraphQLFetcher;
  fetchExistingTrustees: ExistingTrusteesFetcher;
  filterRegisteredHumans: RegisteredHumanFilter;
  isOptedOutBatch: IsOptedOutChecker;
  trustBatch?: TrustBatchExecutor;
  logger: ILoggerService;
};

export type RunOutcome = {
  fetchedUsers: number;
  unclaimedCount: number;
  optedOutCount: number;
  alreadyTrustedCount: number;
  newAvatars: string[];
  trustBatches: string[][];
  trustTxHashes: string[];
  highestBlockSeen: number;
};

export const DEFAULT_FETCH_PAGE_SIZE = 100;
export const DEFAULT_TRUST_BATCH_SIZE = 20;
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_INDEXER_URL =
  "https://indexer.eu.hyperindex.xyz/3bc5dfd/v1/graphql";
export const DEFAULT_CONTRACT_ADDRESS =
  "0x93eD5A96347927ff6fF6b790F8Cf5258240c321f";
export const DEFAULT_START_BLOCK = 46271576;

export async function runOnce(deps: RunDeps, cfg: RunConfig): Promise<RunOutcome> {
  const { fetchUsers, fetchExistingTrustees, filterRegisteredHumans, isOptedOutBatch, trustBatch, logger } = deps;
  const fetchPageSize = Math.max(1, cfg.fetchPageSize);
  const trustBatchSize = Math.max(1, cfg.trustBatchSize);

  if (!cfg.dryRun && !trustBatch) {
    throw new Error("trustBatch executor is required when not in dry-run mode");
  }

  const users = await fetchAllUsers(fetchUsers, cfg.indexerUrl, cfg.startBlock, fetchPageSize, logger);
  logger.info(`Fetched ${users.length} new gnosis-app user(s) above block ${cfg.startBlock}.`);

  const seen = new Set<string>();
  const candidates: string[] = [];
  let highestBlockSeen = cfg.startBlock;

  for (const user of users) {
    if (typeof user.createdAtBlock === "number" && user.createdAtBlock > highestBlockSeen) {
      highestBlockSeen = user.createdAtBlock;
    }
    const normalized = normalizeAddress(user.id);
    if (!normalized) {
      logger.warn(`Skipping invalid avatar id from indexer: ${user.id}`);
      continue;
    }
    const lower = normalized.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    candidates.push(normalized);
  }

  let unclaimedCount = 0;
  let optedOutCount = 0;
  let alreadyTrustedCount = 0;
  let avatars: string[] = candidates;

  if (avatars.length > 0) {
    const claimedLowercase = await filterRegisteredHumans(avatars);
    const claimed = avatars.filter((a) => claimedLowercase.has(a.toLowerCase()));
    unclaimedCount = avatars.length - claimed.length;
    if (unclaimedCount > 0) {
      logger.info(`Skipping ${unclaimedCount} candidate(s) with avatarType != RegisterHuman.`);
    }
    avatars = claimed;
  }

  if (avatars.length > 0) {
    const optOutMap = await isOptedOutBatch(avatars);
    const stillIn = avatars.filter((a) => optOutMap.get(a.toLowerCase()) !== true);
    optedOutCount = avatars.length - stillIn.length;
    if (optedOutCount > 0) {
      logger.info(`Skipping ${optedOutCount} candidate(s) that have opted out of ${cfg.contractAddress}.`);
    }
    avatars = stillIn;
  }

  const existingTrustees = await fetchExistingTrustees(cfg.contractAddress);
  const existingLowercase = new Set(existingTrustees.map((a) => a.toLowerCase()));
  logger.info(`Contract ${cfg.contractAddress} currently trusts ${existingLowercase.size} address(es).`);

  const filtered: string[] = [];
  for (const candidate of avatars) {
    if (existingLowercase.has(candidate.toLowerCase())) {
      alreadyTrustedCount += 1;
      continue;
    }
    filtered.push(candidate);
  }
  avatars = filtered;

  if (alreadyTrustedCount > 0) {
    logger.info(`Skipping ${alreadyTrustedCount} avatar(s) already trusted by ${cfg.contractAddress}.`);
  }

  const trustBatches = chunk(avatars, trustBatchSize);
  const trustTxHashes: string[] = [];

  if (trustBatches.length === 0) {
    logger.info("No new avatars to trust this run.");
    return {
      fetchedUsers: users.length,
      unclaimedCount,
      optedOutCount,
      alreadyTrustedCount,
      newAvatars: avatars,
      trustBatches,
      trustTxHashes,
      highestBlockSeen
    };
  }

  logger.info(
    `Prepared ${trustBatches.length} trust batch(es) (size up to ${trustBatchSize}) for ${avatars.length} new avatar(s).`
  );

  if (cfg.dryRun) {
    for (const [i, batch] of trustBatches.entries()) {
      logger.info(`Dry-run trust batch ${i + 1}/${trustBatches.length}: ${batch.length} avatar(s) -> ${batch.join(", ")}`);
    }
    return {
      fetchedUsers: users.length,
      unclaimedCount,
      optedOutCount,
      alreadyTrustedCount,
      newAvatars: avatars,
      trustBatches,
      trustTxHashes,
      highestBlockSeen
    };
  }

  for (const [i, batch] of trustBatches.entries()) {
    logger.info(`Trusting batch ${i + 1}/${trustBatches.length} (${batch.length} avatar(s))...`);
    const txHash = await trustBatch!(cfg.contractAddress, batch);
    trustTxHashes.push(txHash);
    logger.info(`Trust batch ${i + 1}/${trustBatches.length} succeeded (tx=${txHash}).`);
  }

  return {
    fetchedUsers: users.length,
    unclaimedCount,
    optedOutCount,
    alreadyTrustedCount,
    newAvatars: avatars,
    trustBatches,
    trustTxHashes,
    highestBlockSeen
  };
}

async function fetchAllUsers(
  fetchUsers: GraphQLFetcher,
  indexerUrl: string,
  startBlock: number,
  pageSize: number,
  logger: ILoggerService
): Promise<GnosisAppUser[]> {
  const results: GnosisAppUser[] = [];
  let offset = 0;
  const HARD_PAGE_CAP = 1000;

  for (let page = 0; page < HARD_PAGE_CAP; page++) {
    const query = `{ GnosisAppUser(where:{createdAtBlock:{_gt:${startBlock}}}, order_by:{createdAtBlock:asc}, limit:${pageSize}, offset:${offset}){ id createdAtBlock lifetimeCashback } }`;
    logger.debug(`Querying ${indexerUrl} page=${page} offset=${offset} limit=${pageSize}`);
    const payload = await fetchUsers(query);
    const batch = parseUsers(payload);
    results.push(...batch);
    if (batch.length < pageSize) {
      return results;
    }
    offset += pageSize;
  }

  logger.warn(`Pagination cap of ${HARD_PAGE_CAP} pages reached; returning ${results.length} users so far.`);
  return results;
}

function parseUsers(payload: unknown): GnosisAppUser[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: { GnosisAppUser?: unknown } }).data;
  const raw = data?.GnosisAppUser;
  if (!Array.isArray(raw)) return [];

  const users: GnosisAppUser[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const createdAtBlockRaw = (entry as { createdAtBlock?: unknown }).createdAtBlock;
    const lifetimeCashback = (entry as { lifetimeCashback?: string | number }).lifetimeCashback;
    if (typeof id !== "string") continue;
    const createdAtBlock = typeof createdAtBlockRaw === "number"
      ? createdAtBlockRaw
      : Number(createdAtBlockRaw);
    if (!Number.isFinite(createdAtBlock)) continue;
    users.push({ id, createdAtBlock, lifetimeCashback });
  }
  return users;
}

export async function defaultGraphQLFetcher(
  indexerUrl: string,
  query: string,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Indexer request failed: HTTP ${response.status} ${response.statusText} ${text}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

export const __testables = {
  parseUsers,
  normalizeAddress,
  chunk
};
