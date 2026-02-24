import {CirclesQuery, CirclesRpc} from "@circles-sdk/data";
import {getAddress} from "ethers";
import {IBlacklistingService, IBlacklistServiceVerdict} from "../../interfaces/IBlacklistingService";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IGroupService} from "../../interfaces/IGroupService";
import {IAvatarSafeService} from "../../interfaces/IAvatarSafeService";
import {IAvatarSafeMappingStore} from "../../interfaces/IAvatarSafeMappingStore";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";

export type RunConfig = {
  rpcUrl: string;
  fetchPageSize?: number;
  groupAddress: string;
  dryRun?: boolean;
  groupBatchSize?: number;
};

export type Deps = {
  blacklistingService: IBlacklistingService;
  avatarSafeService: IAvatarSafeService;
  circlesRpc: ICirclesRpc;
  groupService?: IGroupService;
  logger: ILoggerService;
  avatarSafeMappingStore?: IAvatarSafeMappingStore;
};

export type RunOutcome = {
  processed: boolean;
  totalAvatarRows: number;
  uniqueAvatarCount: number;
  allowedAvatars: string[];
  blacklistedAvatars: string[];
  trustedAvatars: string[];
  trustTxHashes: string[];
  untrustedAvatars: string[];
  untrustTxHashes: string[];
  safeReassignmentUntrustedAvatars: string[];
};

type RegisterHumanRow = {
  avatar?: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
};

export const DEFAULT_FETCH_PAGE_SIZE = 1_000;
export const DEFAULT_GROUP_BATCH_SIZE = 10;

const BLACKLIST_FETCH_MAX_ATTEMPTS = 3;
const BLACKLIST_FETCH_RETRY_DELAY_MS = 2_000;

const TRUST_BATCH_MAX_ATTEMPTS = 3;
const TRUST_BATCH_RETRY_DELAY_MS = 1_500;
const UNTRUST_BATCH_MAX_ATTEMPTS = 3;
const UNTRUST_BATCH_RETRY_DELAY_MS = 1_500;
const MAX_SAFE_OWNER_SWITCHES = 2;

export async function runOnce(
  deps: Deps,
  cfg: RunConfig
): Promise<RunOutcome> {
  const {blacklistingService, avatarSafeService, circlesRpc, groupService, logger, avatarSafeMappingStore} = deps;
  const fetchPageSize = Math.max(1, cfg.fetchPageSize ?? DEFAULT_FETCH_PAGE_SIZE);
  const groupBatchSize = Math.max(1, cfg.groupBatchSize ?? DEFAULT_GROUP_BATCH_SIZE);
  const dryRun = !!cfg.dryRun;
  const groupAddress = normalizeAddress(cfg.groupAddress);

  if (!groupAddress) {
    throw new Error(`Invalid group address configured: '${cfg.groupAddress}'`);
  }

  if (!dryRun && !groupService) {
    throw new Error("Group service dependency is required when gp-crc is not running in dry-run mode");
  }

  const humansLogger = logger.child("humans");
  const humanAvatars = await fetchAllHumanAvatars(cfg.rpcUrl, fetchPageSize, humansLogger);
  const uniqueAvatars = uniqueNormalizedAddresses(humanAvatars);

  humansLogger.info(`Fetched ${humanAvatars.length} RegisterHuman rows (${uniqueAvatars.length} unique avatars).`);

  const rawGroupTrustees = await circlesRpc.fetchAllTrustees(groupAddress);
  const currentTrusteesMap = new Map<string, string>();

  for (const trustee of rawGroupTrustees) {
    const normalized = normalizeAddress(trustee);
    if (!normalized) {
      logger.debug(`Ignoring invalid trustee address returned for group ${groupAddress}: ${trustee}`);
      continue;
    }
    currentTrusteesMap.set(normalized.toLowerCase(), normalized);
  }

  const evaluationCandidatesMap = new Map<string, string>(currentTrusteesMap);
  for (const avatar of uniqueAvatars) {
    evaluationCandidatesMap.set(avatar.toLowerCase(), avatar);
  }
  const evaluationCandidates = Array.from(evaluationCandidatesMap.values());

  if (evaluationCandidates.length === 0) {
    logger.info(`No avatars to evaluate against the blacklist.`);
    return {
      processed: true,
      totalAvatarRows: humanAvatars.length,
      uniqueAvatarCount: 0,
      allowedAvatars: [],
      blacklistedAvatars: [],
      trustedAvatars: [],
      trustTxHashes: [],
      untrustedAvatars: [],
      untrustTxHashes: [],
      safeReassignmentUntrustedAvatars: []
    };
  }

  const {allowed: allowedCandidates, blacklisted: blacklistedCandidates} = await partitionBlacklistedAddresses(
    blacklistingService,
    evaluationCandidates,
    logger
  );

  logger.info(
    `Avatar evaluation summary: ${uniqueAvatars.length} unique avatar(s); evaluated ${evaluationCandidates.length} total ` +
    `(allowed ${allowedCandidates.length}, blacklisted ${blacklistedCandidates.length}).`
  );

  const blacklistedLowerSet = new Set(blacklistedCandidates.map((addr) => addr.toLowerCase()));
  const allowedLowerSet = new Set(allowedCandidates.map((addr) => addr.toLowerCase()));

  const allowedAvatars = uniqueAvatars.filter((avatar) => allowedLowerSet.has(avatar.toLowerCase()));
  const blacklistedAvatars = uniqueAvatars.filter((avatar) => blacklistedLowerSet.has(avatar.toLowerCase()));

  let eligibleCandidates: string[] = [];
  let avatarsWithoutSafe: string[] = [];
  let avatarsWithSafes = new Map<string, string>();
  let selectedOwnersBySafe = new Map<string, { avatar: string; timestamp: string }>();

  if (allowedCandidates.length > 0) {
    logger.info(`Checking configured safes for ${allowedCandidates.length} allowed avatar(s).`);
    const safeResult = await avatarSafeService.findAvatarsWithSafes(allowedCandidates);
    avatarsWithSafes = safeResult.mappings;
    selectedOwnersBySafe = safeResult.selectedOwnersBySafe;
  } else {
    logger.info(`No allowed avatars to verify for safes.`);
  }

  const safeReassignmentUntrustedAvatars: string[] = [];
  if (avatarSafeMappingStore) {
    const storedMapping = await avatarSafeMappingStore.load();
    logger.info(`Loaded avatar-safe mapping with ${storedMapping.size} stored entry/entries.`);
    const storedSafeTrustState = await avatarSafeMappingStore.loadSafeTrustState();

    const storedSafeToAvatar = new Map<string, string>();
    for (const [storedAvatar, storedSafe] of storedMapping.entries()) {
      storedSafeToAvatar.set(storedSafe, storedAvatar);
    }

    const effectiveOwnersBySafe = new Map(selectedOwnersBySafe);
    for (const [safe, selected] of selectedOwnersBySafe.entries()) {
      const previousState = storedSafeTrustState.get(safe);
      const previousAvatar = previousState?.trustedAvatar ?? storedSafeToAvatar.get(safe);

      if (!previousAvatar) {
        storedSafeTrustState.set(safe, {
          trustedAvatar: selected.avatar,
          trustedTimestamp: selected.timestamp,
          switchCount: 0
        });
        continue;
      }

      if (previousAvatar.toLowerCase() === selected.avatar.toLowerCase()) {
        const updatedTimestamp = previousState?.trustedTimestamp
          ? (compareTimestamp(selected.timestamp, previousState.trustedTimestamp) > 0
              ? selected.timestamp
              : previousState.trustedTimestamp)
          : selected.timestamp;

        storedSafeTrustState.set(safe, {
          trustedAvatar: selected.avatar,
          trustedTimestamp: updatedTimestamp,
          switchCount: normalizeSwitchCount(previousState?.switchCount ?? 0)
        });
        continue;
      }

      const currentSwitchCount = normalizeSwitchCount(previousState?.switchCount ?? 0);
      const previousTimestamp = previousState?.trustedTimestamp ?? selected.timestamp;
      const isNewer = compareTimestamp(selected.timestamp, previousTimestamp) > 0;
      const canSwitch = isNewer && currentSwitchCount < MAX_SAFE_OWNER_SWITCHES;

      if (canSwitch) {
        logger.info(
          `Safe ${safe} reassigned ${previousAvatar} -> ${selected.avatar} (timestamp ${previousTimestamp} -> ${selected.timestamp}). ` +
          `Switch ${currentSwitchCount + 1}/${MAX_SAFE_OWNER_SWITCHES}.`
        );
        safeReassignmentUntrustedAvatars.push(previousAvatar);
        storedSafeTrustState.set(safe, {
          trustedAvatar: selected.avatar,
          trustedTimestamp: selected.timestamp,
          switchCount: currentSwitchCount + 1
        });
        continue;
      }

      const reason = isNewer
        ? `switch limit reached (${currentSwitchCount}/${MAX_SAFE_OWNER_SWITCHES})`
        : `new timestamp ${selected.timestamp} is not newer than trusted ${previousTimestamp}`;
      logger.info(
        `Safe ${safe} keeps trusted avatar ${previousAvatar}; candidate ${selected.avatar} ignored (${reason}).`
      );
      effectiveOwnersBySafe.set(safe, {
        avatar: previousAvatar,
        timestamp: previousTimestamp
      });
      storedSafeTrustState.set(safe, {
        trustedAvatar: previousAvatar,
        trustedTimestamp: previousTimestamp,
        switchCount: currentSwitchCount
      });
    }

    avatarsWithSafes = new Map<string, string>();
    for (const [safe, owner] of effectiveOwnersBySafe.entries()) {
      avatarsWithSafes.set(owner.avatar, safe);
    }

    const updatedMapping = new Map<string, string>();
    const effectiveAvatarLowerSet = new Set(Array.from(avatarsWithSafes.keys()).map((a) => a.toLowerCase()));
    const evaluationCandidateLowerSet = new Set(
      evaluationCandidates.map((a) => a.toLowerCase())
    );
    for (const [storedAvatar] of Array.from(storedMapping.entries())) {
      if (
        !evaluationCandidateLowerSet.has(storedAvatar.toLowerCase()) ||
        effectiveAvatarLowerSet.has(storedAvatar.toLowerCase())
      ) {
        updatedMapping.set(storedAvatar, storedMapping.get(storedAvatar)!);
      }
    }
    for (const [avatar, safe] of avatarsWithSafes.entries()) {
      updatedMapping.set(avatar, safe);
    }

    await avatarSafeMappingStore.save(updatedMapping);
    await avatarSafeMappingStore.saveSafeTrustState(storedSafeTrustState);
    logger.info(
      `Saved updated avatar-safe mapping with ${updatedMapping.size} entry/entries and ${storedSafeTrustState.size} safe state entry/entries.`
    );
  }

  for (const avatar of allowedCandidates) {
    if (avatarsWithSafes.has(avatar)) {
      eligibleCandidates.push(avatar);
    } else {
      avatarsWithoutSafe.push(avatar);
    }
  }

  logger.info(
    `Avatar safe summary: ${eligibleCandidates.length} with safes, ${avatarsWithoutSafe.length} without safes.`
  );

  if (avatarsWithoutSafe.length > 0) {
    logger.info(`Skipping ${avatarsWithoutSafe.length} avatar(s) without configured safes.`);
  }

  const trustedAvatars: string[] = [];
  const trustTxHashes: string[] = [];
  const untrustedAvatars: string[] = [];
  const untrustTxHashes: string[] = [];

  const eligibleLowerSet = new Set(eligibleCandidates.map((avatar) => avatar.toLowerCase()));
  const currentTrustedLowerSet = new Set(currentTrusteesMap.keys());

  const avatarsToTrust = eligibleCandidates.filter((avatar) => !currentTrustedLowerSet.has(avatar.toLowerCase()));
  const avatarsToUntrust = Array.from(currentTrustedLowerSet)
    .filter((lower) => !eligibleLowerSet.has(lower))
    .map((lower) => currentTrusteesMap.get(lower))
    .filter((address): address is string => !!address);

  const untrustLowerSet = new Set(avatarsToUntrust.map((a) => a.toLowerCase()));
  for (const avatar of safeReassignmentUntrustedAvatars) {
    const lower = avatar.toLowerCase();
    if (currentTrustedLowerSet.has(lower) && !untrustLowerSet.has(lower)) {
      const normalizedAddress = currentTrusteesMap.get(lower) || avatar;
      avatarsToUntrust.push(normalizedAddress);
      untrustLowerSet.add(lower);
    }
  }

  const alreadyTrustedFromEvents = allowedAvatars
    .filter((avatar) => eligibleLowerSet.has(avatar.toLowerCase()))
    .filter((avatar) => currentTrustedLowerSet.has(avatar.toLowerCase()));

  if (alreadyTrustedFromEvents.length > 0) {
    logger.info(
      `Skipping ${alreadyTrustedFromEvents.length} avatar(s) already trusted in group ${groupAddress}.`
    );
  }

  if (avatarsToUntrust.length > 0) {
    const batches = chunkArray(avatarsToUntrust, groupBatchSize);
    if (dryRun) {
      logger.info(
        `Dry-run mode enabled; would untrust ${avatarsToUntrust.length} avatar(s) in group ${groupAddress} across ${batches.length} batch(es).`
      );
      batches.forEach((batch, index) => {
        logger.info(`DRY RUN untrust batch ${index + 1}/${batches.length}: ${batch.length} avatar(s).`);
      });
      untrustedAvatars.push(...avatarsToUntrust);
    } else {
      logger.info(`Untrusting ${avatarsToUntrust.length} avatar(s) in group ${groupAddress} across ${batches.length} batch(es).`);
      const concreteGroupService = groupService!;
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        logger.info(`Untrusting batch ${i + 1}/${batches.length} (${batch.length} avatars)...`);
        const txHash = await untrustBatchWithRetry(
          concreteGroupService,
          groupAddress,
          batch,
          logger,
          i + 1,
          batches.length
        );
        logger.info(`  - untrust tx hash: ${txHash}`);
        untrustTxHashes.push(txHash);
        untrustedAvatars.push(...batch);
      }
      logger.info(`Untrusted ${untrustedAvatars.length} avatars in total for group ${groupAddress}.`);
    }
  }

  if (avatarsToTrust.length > 0) {
    const batches = chunkArray(avatarsToTrust, groupBatchSize);
    if (dryRun) {
      logger.info(
        `Dry-run mode enabled; would trust ${avatarsToTrust.length} avatar(s) in group ${groupAddress} across ${batches.length} batch(es).`
      );
      batches.forEach((batch, index) => {
        logger.info(`DRY RUN trust batch ${index + 1}/${batches.length}: ${batch.length} avatar(s).`);
      });
      trustedAvatars.push(...avatarsToTrust);
    } else {
      logger.info(`Trusting ${avatarsToTrust.length} avatar(s) in group ${groupAddress} across ${batches.length} batch(es).`);
      const concreteGroupService = groupService!;
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        logger.info(`Trusting batch ${i + 1}/${batches.length} (${batch.length} avatars)...`);
        const txHash = await trustBatchWithRetry(
          concreteGroupService,
          groupAddress,
          batch,
          logger,
          i + 1,
          batches.length
        );
        logger.info(`  - trust tx hash: ${txHash}`);
        trustTxHashes.push(txHash);
        trustedAvatars.push(...batch);
      }
      logger.info(`Trusted ${trustedAvatars.length} avatars in total for group ${groupAddress}.`);
    }
  }

  return {
    processed: true,
    totalAvatarRows: humanAvatars.length,
    uniqueAvatarCount: uniqueAvatars.length,
    allowedAvatars,
    blacklistedAvatars,
    trustedAvatars,
    trustTxHashes,
    untrustedAvatars,
    untrustTxHashes,
    safeReassignmentUntrustedAvatars
  };
}

function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

async function fetchAllHumanAvatars(
  rpcUrl: string,
  pageSize: number,
  logger: ILoggerService
): Promise<string[]> {
  const rpc = new CirclesRpc(rpcUrl);
  const query = new CirclesQuery<RegisterHumanRow>(rpc, {
    namespace: "CrcV2",
    table: "RegisterHuman",
    columns: ["avatar", "blockNumber", "transactionIndex", "logIndex"],
    sortOrder: "ASC",
    limit: pageSize
  });

  const avatars: string[] = [];
  let pages = 0;

  while (await query.queryNextPage()) {
    pages += 1;
    const rows = query.currentPage?.results ?? [];
    for (const row of rows) {
      if (!row || typeof row.avatar !== "string") {
        continue;
      }

      const normalized = normalizeAddress(row.avatar);
      if (normalized) {
        avatars.push(normalized);
      }
    }
  }

  logger.info(`Fetched ${avatars.length} avatars from RegisterHuman table across ${pages} page(s).`);

  return avatars;
}

function uniqueNormalizedAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
      continue;
    }

    const lower = normalized.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }

    seen.add(lower);
    result.push(normalized);
  }

  return result;
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

async function partitionBlacklistedAddresses(
  service: IBlacklistingService,
  addresses: string[],
  logger: ILoggerService
): Promise<{allowed: string[]; blacklisted: string[]}> {
  const allowed: string[] = [];
  const blacklisted: string[] = [];

  const verdicts = await fetchBlacklistVerdictsWithRetry(service, addresses, logger);
  const verdictMap = new Map<string, IBlacklistServiceVerdict>();

  for (const verdict of verdicts) {
    verdictMap.set(verdict.address.toLowerCase(), verdict);
  }

  for (const address of addresses) {
    const verdict = verdictMap.get(address.toLowerCase());
    if (!verdict) {
      logger.warn(`No verdict returned for ${address}; treating as allowed.`);
      allowed.push(address);
      continue;
    }

    if (isBlacklisted(verdict)) {
      blacklisted.push(address);
    } else {
      allowed.push(address);
    }
  }

  return {allowed, blacklisted};
}

function isBlacklisted(verdict: IBlacklistServiceVerdict): boolean {
  if (verdict.is_bot) {
    return true;
  }

  if (!verdict.category) {
    return false;
  }

  const category = verdict.category.toLowerCase();
  return category === "blocked" || category === "flagged";
}

async function trustBatchWithRetry(
  service: IGroupService,
  groupAddress: string,
  batch: string[],
  logger: ILoggerService,
  currentBatch: number,
  totalBatches: number
): Promise<string> {
  for (let attempt = 1; attempt <= TRUST_BATCH_MAX_ATTEMPTS; attempt++) {
    try {
      logger.debug(`Trust batch ${currentBatch}/${totalBatches} attempt ${attempt}/${TRUST_BATCH_MAX_ATTEMPTS}.`);
      return await service.trustBatchWithConditions(groupAddress, batch);
    } catch (error) {
      const retryable = isRetryableTrustError(error);
      if (attempt >= TRUST_BATCH_MAX_ATTEMPTS || !retryable) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      logger.warn(`Trust batch ${currentBatch}/${totalBatches} attempt ${attempt} failed (${formatErrorMessage(error)}). Retrying in ${TRUST_BATCH_RETRY_DELAY_MS} ms.`);
      await wait(TRUST_BATCH_RETRY_DELAY_MS);
    }
  }

  throw new Error("Failed to trust batch after retries");
}

async function untrustBatchWithRetry(
  service: IGroupService,
  groupAddress: string,
  batch: string[],
  logger: ILoggerService,
  currentBatch: number,
  totalBatches: number
): Promise<string> {
  for (let attempt = 1; attempt <= UNTRUST_BATCH_MAX_ATTEMPTS; attempt++) {
    try {
      logger.debug(`Untrust batch ${currentBatch}/${totalBatches} attempt ${attempt}/${UNTRUST_BATCH_MAX_ATTEMPTS}.`);
      return await service.untrustBatch(groupAddress, batch);
    } catch (error) {
      const retryable = isRetryableTrustError(error);
      if (attempt >= UNTRUST_BATCH_MAX_ATTEMPTS || !retryable) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      logger.warn(`Untrust batch ${currentBatch}/${totalBatches} attempt ${attempt} failed (${formatErrorMessage(error)}). Retrying in ${UNTRUST_BATCH_RETRY_DELAY_MS} ms.`);
      await wait(UNTRUST_BATCH_RETRY_DELAY_MS);
    }
  }

  throw new Error("Failed to untrust batch after retries");
}

async function fetchBlacklistVerdictsWithRetry(
  service: IBlacklistingService,
  chunk: string[],
  logger: ILoggerService
): Promise<IBlacklistServiceVerdict[]> {
  for (let attempt = 1; attempt <= BLACKLIST_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await service.checkBlacklist(chunk);
    } catch (error) {
      const retryable = isRetryableFetchError(error);
      if (attempt >= BLACKLIST_FETCH_MAX_ATTEMPTS || !retryable) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      logger.warn(`Blacklist check attempt ${attempt} failed (${formatErrorMessage(error)}). Retrying in ${BLACKLIST_FETCH_RETRY_DELAY_MS} ms.`);
      await wait(BLACKLIST_FETCH_RETRY_DELAY_MS);
    }
  }

  throw new Error("Failed to fetch blacklist verdicts after retries");
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

function isRetryableTrustError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return true;
  }

  const anyError = error as { code?: unknown; message?: unknown };
  const code = typeof anyError.code === "string" ? anyError.code.toUpperCase() : "";
  const message = typeof anyError.message === "string" ? anyError.message.toLowerCase() : "";

  if (code === "CALL_EXCEPTION" || code === "UNPREDICTABLE_GAS_LIMIT" || code === "INSUFFICIENT_FUNDS") {
    return false;
  }

  if (code.includes("NETWORK") || code.includes("SERVER") || code.includes("TIMEOUT")) {
    return true;
  }

  if (message.includes("timeout") || message.includes("network") || message.includes("econnreset") || message.includes("temporarily")) {
    return true;
  }

  if (message.includes("insufficient funds") || message.includes("underpriced") || message.includes("nonce")) {
    return false;
  }

  return false;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSwitchCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function compareTimestamp(left: string, right: string): number {
  const leftComparable = toComparableBigInt(left);
  const rightComparable = toComparableBigInt(right);

  if (leftComparable !== null && rightComparable !== null) {
    if (leftComparable > rightComparable) return 1;
    if (leftComparable < rightComparable) return -1;
    return 0;
  }

  return left.localeCompare(right);
}

function toComparableBigInt(value: string): bigint | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return BigInt(trimmed);
  }

  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return BigInt(parsedDate);
  }

  return null;
}
