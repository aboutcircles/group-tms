import { getAddress } from "ethers";
import { ILoggerService } from "../../interfaces/ILoggerService";

export type GnosisAppUser = {
  id: string;
  createdAtBlock: number;
  lifetimeCashback?: string | number;
};

export type GraphQLFetcher = (query: string) => Promise<unknown>;

export type ExistingTrusteesFetcher = (contractAddress: string) => Promise<string[]>;

/** Returns the subset of the given addresses whose Avatar has avatarType RegisterHuman, lowercased. */
export type RegisteredHumanFilter = (addresses: string[]) => Promise<Set<string>>;

export type IsOptedOutChecker = (addresses: string[]) => Promise<Map<string, boolean>>;

/** Returns the subset of the given addresses that are blacklisted, lowercased. */
export type BlacklistChecker = (addresses: string[]) => Promise<Set<string>>;

/**
 * Returns the subset of the given addresses that are registered as Circles v2
 * human avatars (per the Circles RPC), lowercased.
 */
export type HumanAvatarFilter = (addresses: string[]) => Promise<Set<string>>;

/** Returns relative trust scores keyed by lowercase address. */
export type TrustScoreFetcher = (addresses: string[]) => Promise<Map<string, number>>;

/**
 * Returns the subset of the given addresses for which a simulated
 * `trust(address)` call on the group contract succeeds, lowercased.
 */
export type TrustSimulationFilter = (addresses: string[]) => Promise<Set<string>>;

export type TrustBatchExecutor = (
  contractAddress: string,
  avatars: string[]
) => Promise<string>;

export type RunConfig = {
  indexerUrl: string;
  contractAddress: string;
  cutoffBlock: number;
  scoreThreshold: number;
  fetchPageSize: number;
  trustBatchSize: number;
  fetchTimeoutMs: number;
  dryRun: boolean;
};

export type RunDeps = {
  fetchUsers: GraphQLFetcher;
  fetchExistingTrustees: ExistingTrusteesFetcher;
  filterRegisteredHumans: RegisteredHumanFilter;
  filterHumanAvatars: HumanAvatarFilter;
  isOptedOutBatch: IsOptedOutChecker;
  checkBlacklist: BlacklistChecker;
  fetchTrustScores: TrustScoreFetcher;
  filterTrustable: TrustSimulationFilter;
  trustBatch?: TrustBatchExecutor;
  logger: ILoggerService;
};

export type BackfillOutcome = {
  fetchedUsers: number;
  unclaimedCount: number;
  alreadyTrustedCount: number;
  blacklistedCount: number;
  belowThresholdCount: number;
  optedOutCount: number;
  notHumanCount: number;
  untrustableCount: number;
  newAvatars: string[];
  trustBatches: string[][];
  trustTxHashes: string[];
};

export type RunOutcome = {
  fetchedUsers: number;
  unclaimedCount: number;
  alreadyTrustedCount: number;
  optedOutCount: number;
  notHumanCount: number;
  untrustableCount: number;
  newAvatars: string[];
  trustBatches: string[][];
  trustTxHashes: string[];
  highestBlockSeen: number;
};

// 1000 is the indexer's max page size. With the 1000-page pagination cap this
// allows up to 1M users per fetch; the backfill window alone holds ~300k users,
// which a page size of 100 would silently truncate.
export const DEFAULT_FETCH_PAGE_SIZE = 1000;
export const DEFAULT_TRUST_BATCH_SIZE = 20;
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_INDEXER_URL =
  "https://gnosis-e702590.dedicated.hyperindex.xyz/v1/graphql";
export const DEFAULT_CONTRACT_ADDRESS =
  "0x93eD5A96347927ff6fF6b790F8Cf5258240c321f";
export const DEFAULT_SCORE_THRESHOLD = 50;
// First Gnosis block of 2026-05-26 00:00 UTC (~15 days before this logic was deployed).
// Avatars registered before it must pass the blacklist and score checks; avatars
// registered at or after it are trusted unconditionally.
export const DEFAULT_CUTOFF_BLOCK = 46_363_942;

/**
 * One-time pass over avatars registered before the cutoff block: they are only
 * trusted when they are not blacklisted and their relative trust score is
 * above the configured threshold.
 */
export async function runBackfill(deps: RunDeps, cfg: RunConfig): Promise<BackfillOutcome> {
  const { fetchUsers, checkBlacklist, fetchTrustScores, logger } = deps;
  assertTrustExecutor(deps, cfg);

  const users = await fetchAllUsers(
    fetchUsers,
    cfg.indexerUrl,
    `_lt:${cfg.cutoffBlock}`,
    Math.max(1, cfg.fetchPageSize),
    logger
  );
  logger.info(`Backfill: fetched ${users.length} gnosis-app user(s) registered before block ${cfg.cutoffBlock}.`);

  const { candidates } = collectCandidates(users, cfg.cutoffBlock, logger);

  const { remaining: claimed, removed: unclaimedCount } = await dropUnregistered(deps, candidates, logger);
  const { remaining: notTrusted, removed: alreadyTrustedCount } = await dropAlreadyTrusted(deps, cfg, claimed, logger);

  let blacklistedCount = 0;
  let avatars = notTrusted;
  if (avatars.length > 0) {
    const blacklisted = await checkBlacklist(avatars);
    const allowed = avatars.filter((a) => !blacklisted.has(a.toLowerCase()));
    blacklistedCount = avatars.length - allowed.length;
    if (blacklistedCount > 0) {
      logger.info(`Backfill: skipping ${blacklistedCount} blacklisted avatar(s).`);
    }
    avatars = allowed;
  }

  let belowThresholdCount = 0;
  if (avatars.length > 0) {
    const scores = await fetchTrustScores(avatars);
    const aboveThreshold = avatars.filter((a) => (scores.get(a.toLowerCase()) ?? 0) > cfg.scoreThreshold);
    belowThresholdCount = avatars.length - aboveThreshold.length;
    if (belowThresholdCount > 0) {
      logger.info(
        `Backfill: skipping ${belowThresholdCount} avatar(s) with relative trust score <= ${cfg.scoreThreshold}.`
      );
    }
    avatars = aboveThreshold;
  }

  const { remaining: optedIn, removed: optedOutCount } = await dropOptedOut(deps, cfg, avatars, logger);
  const { remaining: humans, removed: notHumanCount } = await dropNotHuman(deps, optedIn, logger);
  const { remaining: trustable, removed: untrustableCount } = await dropUntrustable(deps, cfg, humans, logger);

  const { trustBatches, trustTxHashes } = await executeTrustPlan(deps, cfg, trustable, "Backfill");

  return {
    fetchedUsers: users.length,
    unclaimedCount,
    alreadyTrustedCount,
    blacklistedCount,
    belowThresholdCount,
    optedOutCount,
    notHumanCount,
    untrustableCount,
    newAvatars: trustable,
    trustBatches,
    trustTxHashes
  };
}

/**
 * Recurring pass over avatars registered at or after the cutoff block: they
 * are trusted irrespective of blacklist status and relative trust score.
 */
export async function runIncremental(deps: RunDeps, cfg: RunConfig): Promise<RunOutcome> {
  const { fetchUsers, logger } = deps;
  assertTrustExecutor(deps, cfg);

  const users = await fetchAllUsers(
    fetchUsers,
    cfg.indexerUrl,
    `_gte:${cfg.cutoffBlock}`,
    Math.max(1, cfg.fetchPageSize),
    logger
  );
  logger.info(`Fetched ${users.length} gnosis-app user(s) registered at or after block ${cfg.cutoffBlock}.`);

  const { candidates, highestBlockSeen } = collectCandidates(users, cfg.cutoffBlock, logger);

  const { remaining: claimed, removed: unclaimedCount } = await dropUnregistered(deps, candidates, logger);
  const { remaining: notTrusted, removed: alreadyTrustedCount } = await dropAlreadyTrusted(deps, cfg, claimed, logger);
  const { remaining: optedIn, removed: optedOutCount } = await dropOptedOut(deps, cfg, notTrusted, logger);
  const { remaining: humans, removed: notHumanCount } = await dropNotHuman(deps, optedIn, logger);
  const { remaining: trustable, removed: untrustableCount } = await dropUntrustable(deps, cfg, humans, logger);

  const { trustBatches, trustTxHashes } = await executeTrustPlan(deps, cfg, trustable, "Incremental");

  return {
    fetchedUsers: users.length,
    unclaimedCount,
    alreadyTrustedCount,
    optedOutCount,
    notHumanCount,
    untrustableCount,
    newAvatars: trustable,
    trustBatches,
    trustTxHashes,
    highestBlockSeen
  };
}

function assertTrustExecutor(deps: RunDeps, cfg: RunConfig): void {
  if (!cfg.dryRun && !deps.trustBatch) {
    throw new Error("trustBatch executor is required when not in dry-run mode");
  }
}

function collectCandidates(
  users: GnosisAppUser[],
  initialHighestBlock: number,
  logger: ILoggerService
): { candidates: string[]; highestBlockSeen: number } {
  const seen = new Set<string>();
  const candidates: string[] = [];
  let highestBlockSeen = initialHighestBlock;

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

  return { candidates, highestBlockSeen };
}

async function dropUnregistered(
  deps: RunDeps,
  avatars: string[],
  logger: ILoggerService
): Promise<{ remaining: string[]; removed: number }> {
  if (avatars.length === 0) {
    return { remaining: avatars, removed: 0 };
  }

  const claimedLowercase = await deps.filterRegisteredHumans(avatars);
  const claimed = avatars.filter((a) => claimedLowercase.has(a.toLowerCase()));
  const removed = avatars.length - claimed.length;
  if (removed > 0) {
    logger.info(`Skipping ${removed} candidate(s) with avatarType != RegisterHuman.`);
  }
  return { remaining: claimed, removed };
}

async function dropAlreadyTrusted(
  deps: RunDeps,
  cfg: RunConfig,
  avatars: string[],
  logger: ILoggerService
): Promise<{ remaining: string[]; removed: number }> {
  const existingTrustees = await deps.fetchExistingTrustees(cfg.contractAddress);
  const existingLowercase = new Set(existingTrustees.map((a) => a.toLowerCase()));
  logger.info(`Contract ${cfg.contractAddress} currently trusts ${existingLowercase.size} address(es).`);

  const remaining = avatars.filter((a) => !existingLowercase.has(a.toLowerCase()));
  const removed = avatars.length - remaining.length;
  if (removed > 0) {
    logger.info(`Skipping ${removed} avatar(s) already trusted by ${cfg.contractAddress}.`);
  }
  return { remaining, removed };
}

async function dropNotHuman(
  deps: RunDeps,
  avatars: string[],
  logger: ILoggerService
): Promise<{ remaining: string[]; removed: number }> {
  if (avatars.length === 0) {
    return { remaining: avatars, removed: 0 };
  }

  const humansLowercase = await deps.filterHumanAvatars(avatars);
  const remaining = avatars.filter((a) => humansLowercase.has(a.toLowerCase()));
  const removed = avatars.length - remaining.length;
  if (removed > 0) {
    const dropped = avatars.filter((a) => !humansLowercase.has(a.toLowerCase()));
    logger.warn(
      `Skipping ${removed} candidate(s) that are not registered Circles humans: ${dropped.join(", ")}`
    );
  }
  return { remaining, removed };
}

/**
 * Drops avatars for which a simulated trust() call on the group contract
 * reverts. The group's eligibility check inspects the avatar's wallet
 * implementation on-chain (beyond Hub registration), so registry-based
 * filters cannot fully replicate it; a single ineligible avatar would
 * revert its whole trust batch.
 */
async function dropUntrustable(
  deps: RunDeps,
  cfg: RunConfig,
  avatars: string[],
  logger: ILoggerService
): Promise<{ remaining: string[]; removed: number }> {
  if (avatars.length === 0) {
    return { remaining: avatars, removed: 0 };
  }

  const trustableLowercase = await deps.filterTrustable(avatars);
  const remaining = avatars.filter((a) => trustableLowercase.has(a.toLowerCase()));
  const removed = avatars.length - remaining.length;
  if (removed > 0) {
    const dropped = avatars.filter((a) => !trustableLowercase.has(a.toLowerCase()));
    logger.warn(
      `Skipping ${removed} candidate(s) whose trust() simulation reverts on ${cfg.contractAddress}: ${dropped.join(", ")}`
    );
  }
  return { remaining, removed };
}

async function dropOptedOut(
  deps: RunDeps,
  cfg: RunConfig,
  avatars: string[],
  logger: ILoggerService
): Promise<{ remaining: string[]; removed: number }> {
  if (avatars.length === 0) {
    return { remaining: avatars, removed: 0 };
  }

  const optOutMap = await deps.isOptedOutBatch(avatars);
  const stillIn = avatars.filter((a) => optOutMap.get(a.toLowerCase()) !== true);
  const removed = avatars.length - stillIn.length;
  if (removed > 0) {
    logger.info(`Skipping ${removed} candidate(s) that have opted out of ${cfg.contractAddress}.`);
  }
  return { remaining: stillIn, removed };
}

async function executeTrustPlan(
  deps: RunDeps,
  cfg: RunConfig,
  avatars: string[],
  phaseLabel: string
): Promise<{ trustBatches: string[][]; trustTxHashes: string[] }> {
  const { trustBatch, logger } = deps;
  const trustBatchSize = Math.max(1, cfg.trustBatchSize);
  const trustBatches = chunk(avatars, trustBatchSize);
  const trustTxHashes: string[] = [];

  if (trustBatches.length === 0) {
    logger.info(`${phaseLabel}: no new avatars to trust.`);
    return { trustBatches, trustTxHashes };
  }

  logger.info(
    `${phaseLabel}: prepared ${trustBatches.length} trust batch(es) (size up to ${trustBatchSize}) for ${avatars.length} new avatar(s).`
  );

  if (cfg.dryRun) {
    for (const [i, batch] of trustBatches.entries()) {
      logger.info(`Dry-run trust batch ${i + 1}/${trustBatches.length}: ${batch.length} avatar(s) -> ${batch.join(", ")}`);
    }
    return { trustBatches, trustTxHashes };
  }

  for (const [i, batch] of trustBatches.entries()) {
    logger.info(`Trusting batch ${i + 1}/${trustBatches.length} (${batch.length} avatar(s))...`);
    const txHash = await trustBatch!(cfg.contractAddress, batch);
    trustTxHashes.push(txHash);
    logger.info(`Trust batch ${i + 1}/${trustBatches.length} succeeded (tx=${txHash}).`);
  }

  return { trustBatches, trustTxHashes };
}

async function fetchAllUsers(
  fetchUsers: GraphQLFetcher,
  indexerUrl: string,
  blockFilter: string,
  pageSize: number,
  logger: ILoggerService
): Promise<GnosisAppUser[]> {
  const results: GnosisAppUser[] = [];
  let offset = 0;
  const HARD_PAGE_CAP = 1000;

  for (let page = 0; page < HARD_PAGE_CAP; page++) {
    const query = `{ GnosisAppUser(where:{createdAtBlock:{${blockFilter}}}, order_by:{createdAtBlock:asc}, limit:${pageSize}, offset:${offset}){ id createdAtBlock lifetimeCashback } }`;
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
  chunk,
  collectCandidates
};
