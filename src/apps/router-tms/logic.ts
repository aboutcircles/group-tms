import {getAddress} from "ethers";
import {IBlacklistingService, IBlacklistServiceVerdict} from "../../interfaces/IBlacklistingService";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IRouterService} from "../../interfaces/IRouterService";
import {IRouterEnablementStore} from "../../interfaces/IRouterEnablementStore";

export type RunConfig = {
  rpcUrl: string;
  routerAddress: string;
  baseGroupAddress?: string;
  dryRun?: boolean;
  enableBatchSize?: number;
  fetchPageSize?: number;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  blacklistingService: IBlacklistingService;
  routerService?: IRouterService;
  logger: ILoggerService;
  enablementStore: IRouterEnablementStore;
};

export type RunOutcome = {
  totalAvatarEntries: number;
  uniqueHumanCount: number;
  allowedHumanCount: number;
  blacklistedHumanCount: number;
  alreadyTrustedCount: number;
  pendingEnableCount: number;
  executedEnableCount: number;
  dryRun: boolean;
  txHashes: string[];
};

type EnableTarget = {baseGroup: string; addresses: string[]; source?: "base-group" | "fallback"};

export const DEFAULT_ENABLE_BATCH_SIZE = 10;
export const DEFAULT_FETCH_PAGE_SIZE = 1_000;
export const DEFAULT_BASE_GROUP_ADDRESS = "0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026";
const HUMANITY_CHECK_BATCH_SIZE = 50;

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<RunOutcome> {
  const {circlesRpc, blacklistingService, routerService, logger, enablementStore} = deps;
  const dryRun = !!cfg.dryRun;

  const routerAddress = normalizeAddress(cfg.routerAddress);
  if (!routerAddress) {
    throw new Error(`Invalid router address configured: '${cfg.routerAddress}'`);
  }

  const baseGroupAddress = normalizeAddress(cfg.baseGroupAddress ?? DEFAULT_BASE_GROUP_ADDRESS);
  if (!baseGroupAddress) {
    throw new Error(`Invalid base group address configured: '${cfg.baseGroupAddress ?? DEFAULT_BASE_GROUP_ADDRESS}'`);
  }

  if (!dryRun && !routerService) {
    throw new Error("Router service dependency is required when router-tms is not running in dry-run mode.");
  }

  const enableBatchSize = Math.max(1, cfg.enableBatchSize ?? DEFAULT_ENABLE_BATCH_SIZE);
  const fetchPageSize = Math.max(1, cfg.fetchPageSize ?? DEFAULT_FETCH_PAGE_SIZE);
  const isHuman = createIsHumanChecker(circlesRpc);

  await assertBaseGroupIsGroupAvatar(baseGroupAddress, isHuman, logger);

  logger.info("Fetching human avatars from RegisterHuman table...");
  const allHumanAvatars = await circlesRpc.fetchAllHumanAvatars(fetchPageSize, logger);
  const totalAvatarEntries = allHumanAvatars.length;
  const uniqueHumanAvatars = Array.from(new Set(allHumanAvatars));
  logger.info(`Fetched ${totalAvatarEntries} avatar row(s) (${uniqueHumanAvatars.length} unique).`);

  logger.info(`Evaluating blacklist for ${uniqueHumanAvatars.length} unique avatar(s)...`);
  const {allowed: allowedHumanAvatars, blacklisted: blacklistedHumanAvatars} = await partitionBlacklistedAddresses(
    blacklistingService,
    uniqueHumanAvatars,
    logger
  );
  logger.info(
    `Blacklist evaluation complete. Allowed: ${allowedHumanAvatars.length}, blacklisted: ${blacklistedHumanAvatars.length}.`
  );

  logger.info(`Fetching router trust list for ${routerAddress}...`);
  const routerTrustees = await circlesRpc.fetchAllTrustees(routerAddress);
  const routerTrustSet = new Set(normalizeAddressArray(routerTrustees));
  logger.info(`Router already trusts ${routerTrustSet.size} address(es).`);

  const alreadyTrusted = allowedHumanAvatars.filter((address) => routerTrustSet.has(address));
  const previouslyEnabled = new Set(normalizeAddressArray(await enablementStore.loadEnabledAddresses()));

  const allowedHumanSet = new Set(allowedHumanAvatars);
  const blacklistedSet = new Set(blacklistedHumanAvatars);
  const avatarBaseGroupAssignments = await buildAvatarBaseGroupAssignments(circlesRpc, logger);
  const baseGroupAvatars = Array.from(avatarBaseGroupAssignments.keys());
  const unknownBaseGroupAvatars = baseGroupAvatars.filter(
    (avatar) => !allowedHumanSet.has(avatar) && !blacklistedSet.has(avatar)
  );

  const allowedBaseGroupAvatars = new Set<string>(allowedHumanSet);
  const blacklistedBaseGroupAvatars = new Set<string>(blacklistedSet);

  if (unknownBaseGroupAvatars.length > 0) {
    logger.info(
      `Evaluating blacklist for ${unknownBaseGroupAvatars.length} base group member(s) not present in RegisterHuman table...`
    );
    const {allowed, blacklisted} = await partitionBlacklistedAddresses(
      blacklistingService,
      unknownBaseGroupAvatars,
      logger
    );
    allowed.forEach((address) => allowedBaseGroupAvatars.add(address));
    blacklisted.forEach((address) => blacklistedBaseGroupAvatars.add(address));
  }

  const eligibilityFilter = (avatar: string): boolean =>
    !routerTrustSet.has(avatar) && !previouslyEnabled.has(avatar);

  const {
    targets: baseGroupEnableTargets,
    scheduledAvatars: baseGroupScheduledAvatars
  } = buildBaseGroupEnableTargets(
    avatarBaseGroupAssignments,
    allowedBaseGroupAvatars,
    blacklistedBaseGroupAvatars,
    eligibilityFilter
  );

  const remainingHumanAvatars = allowedHumanAvatars.filter(
    (avatar) => eligibilityFilter(avatar) && !baseGroupScheduledAvatars.has(avatar)
  );

  const enableTargets: EnableTarget[] = [...baseGroupEnableTargets];
  if (remainingHumanAvatars.length > 0) {
    enableTargets.push({baseGroup: baseGroupAddress, addresses: remainingHumanAvatars, source: "fallback"});
  }

  const {validTargets, nonHumanAvatars} = await validateEnableTargets(
    enableTargets,
    isHuman,
    baseGroupAddress,
    logger
  );

  if (nonHumanAvatars.size > 0) {
    logger.warn(`Skipped ${nonHumanAvatars.size} avatar(s) flagged as non-human by the Circles hub.`);
  }

  const pendingEnableCount = validTargets.reduce((sum, target) => sum + target.addresses.length, 0);

  if (pendingEnableCount === 0) {
    logger.info("No eligible human avatars remain for routing after blacklist and hub validation.");
    return {
      totalAvatarEntries,
      uniqueHumanCount: uniqueHumanAvatars.length,
      allowedHumanCount: allowedHumanAvatars.length,
      blacklistedHumanCount: blacklistedHumanAvatars.length,
      alreadyTrustedCount: alreadyTrusted.length,
      pendingEnableCount: 0,
      executedEnableCount: 0,
      dryRun,
      txHashes: []
    };
  }

  const baseGroupTargets = validTargets.filter((target) => target.source === "base-group");
  if (baseGroupTargets.length > 0) {
    const baseGroupAvatarCount = baseGroupTargets.reduce((sum, target) => sum + target.addresses.length, 0);
    logger.info(
      `Need to enable routing for ${baseGroupAvatarCount} base group member(s) across ${baseGroupTargets.length} base group target(s).`
    );
  }

  const fallbackTargets = validTargets.filter((target) => target.source === "fallback");
  if (fallbackTargets.length > 0) {
    const fallbackAvatarCount = fallbackTargets.reduce((sum, target) => sum + target.addresses.length, 0);
    logger.info(
      `Need to enable routing for ${fallbackAvatarCount} remaining human avatar(s) in default base group ${baseGroupAddress}.`
    );
  }

  const txHashes: string[] = [];
  let executedEnableCount = 0;

  for (const target of validTargets) {
    const batches = chunkArray(target.addresses, enableBatchSize);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      if (dryRun || !routerService) {
        logger.info(
          `[DRY-RUN] Would call enableCRCForRouting with ${batch.length} avatar(s) ` +
            `(batch ${batchIndex + 1}/${batches.length}) for base group ${target.baseGroup}.`
        );
        continue;
      }

      const txHash = await routerService.enableCRCForRouting(target.baseGroup, batch);
      txHashes.push(txHash);
      executedEnableCount += batch.length;
      await enablementStore.markEnabled(batch);
      batch.forEach((address) => routerTrustSet.add(address));
      logger.info(
        `enableCRCForRouting tx=${txHash} (batch ${batchIndex + 1}/${batches.length}) for ${batch.length} avatar(s) in base group ${target.baseGroup}.`
      );
    }
  }

  return {
    totalAvatarEntries,
    uniqueHumanCount: uniqueHumanAvatars.length,
    allowedHumanCount: allowedHumanAvatars.length,
    blacklistedHumanCount: blacklistedHumanAvatars.length,
    alreadyTrustedCount: alreadyTrusted.length,
    pendingEnableCount,
    executedEnableCount: dryRun ? 0 : executedEnableCount,
    dryRun,
    txHashes
  };
}

async function partitionBlacklistedAddresses(
  service: IBlacklistingService,
  addresses: string[],
  logger: ILoggerService
): Promise<{allowed: string[]; blacklisted: string[]}> {
  const allowed: string[] = [];
  const blacklisted: string[] = [];

  const verdicts = await service.checkBlacklist(addresses);
  const verdictMap = new Map<string, IBlacklistServiceVerdict>();

  for (const verdict of verdicts) {
    verdictMap.set(verdict.address.toLowerCase(), verdict);
  }

  for (const address of addresses) {
    const verdict = verdictMap.get(address.toLowerCase());
    if (!verdict) {
      logger.warn(`No blacklist verdict returned for ${address}; treating as allowed.`);
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

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    return [values];
  }

  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

function normalizeAddress(address: string | undefined | null): string | undefined {
  if (!address || typeof address !== "string") {
    return undefined;
  }

  try {
    return getAddress(address).toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeAddressArray(addresses: string[]): string[] {
  const unique = new Set<string>();
  for (const value of addresses) {
    const normalized = normalizeAddress(value);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function createIsHumanChecker(circlesRpc: ICirclesRpc): (address: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return async (address: string): Promise<boolean> => {
    const normalized = normalizeAddress(address);
    if (!normalized) {
      throw new Error(`Invalid address passed to isHuman check: '${address ?? ""}'`);
    }

    const cached = cache.get(normalized);
    if (cached) {
      return cached;
    }

    const lookup = circlesRpc.isHuman(normalized).catch((error) => {
      cache.delete(normalized);
      throw error;
    });

    cache.set(normalized, lookup);
    return lookup;
  };
}

async function filterHumanAvatars(
  addresses: string[],
  isHuman: (address: string) => Promise<boolean>,
  batchSize: number
): Promise<{humans: string[]; nonHumans: string[]}> {
  const humans: string[] = [];
  const nonHumans: string[] = [];

  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const verdicts = await Promise.all(batch.map((address) => isHuman(address)));

    for (let j = 0; j < batch.length; j += 1) {
      const address = batch[j];
      if (verdicts[j]) {
        humans.push(address);
      } else {
        nonHumans.push(address);
      }
    }
  }

  return {humans, nonHumans};
}

async function validateEnableTargets(
  enableTargets: EnableTarget[],
  isHuman: (address: string) => Promise<boolean>,
  defaultBaseGroup: string,
  logger: ILoggerService
): Promise<{validTargets: EnableTarget[]; nonHumanAvatars: Set<string>}> {
  const validTargets: EnableTarget[] = [];
  const nonHumanAvatars = new Set<string>();
  const defaultBaseGroupLc = defaultBaseGroup.toLowerCase();

  for (const target of enableTargets) {
    const baseGroupIsHuman = await isHuman(target.baseGroup);
    if (baseGroupIsHuman) {
      const message = `Base group ${target.baseGroup} is a human avatar according to the Circles hub contract.`;
      if (target.baseGroup.toLowerCase() === defaultBaseGroupLc) {
        throw new Error(message);
      }

      logger.error(`${message} Skipping this base group.`);
      continue;
    }

    const {humans, nonHumans} = await filterHumanAvatars(target.addresses, isHuman, HUMANITY_CHECK_BATCH_SIZE);
    nonHumans.forEach((avatar) => nonHumanAvatars.add(avatar));

    if (nonHumans.length > 0) {
      logger.warn(`Skipping ${nonHumans.length} non-human avatar(s) for base group ${target.baseGroup}.`);
    }

    if (humans.length === 0) {
      logger.info(`No human avatars remain for base group ${target.baseGroup} after hub validation.`);
      continue;
    }

    validTargets.push({baseGroup: target.baseGroup, addresses: humans, source: target.source});
  }

  return {validTargets, nonHumanAvatars};
}

async function assertBaseGroupIsGroupAvatar(
  baseGroup: string,
  isHuman: (address: string) => Promise<boolean>,
  logger: ILoggerService
): Promise<void> {
  const baseGroupIsHuman = await isHuman(baseGroup);
  if (baseGroupIsHuman) {
    const message = `Base group ${baseGroup} is a human avatar according to the Circles hub contract.`;
    logger.error(message);
    throw new Error(message);
  }
}

async function buildAvatarBaseGroupAssignments(
  circlesRpc: ICirclesRpc,
  logger: ILoggerService
): Promise<Map<string, string>> {
  logger.info("Fetching base groups to map avatar assignments...");
  const baseGroups = await circlesRpc.fetchAllBaseGroups();
  const normalizedBaseGroups = normalizeAddressArray(baseGroups);
  logger.info(`Fetched ${normalizedBaseGroups.length} base group(s).`);

  const assignment = new Map<string, string>();
  for (const baseGroup of normalizedBaseGroups) {
    const trustees = await circlesRpc.fetchAllTrustees(baseGroup);
    const normalizedTrustees = normalizeAddressArray(trustees);
    logger.info(`Base group ${baseGroup} has ${normalizedTrustees.length} trustee(s).`);
    for (const trustee of normalizedTrustees) {
      if (!assignment.has(trustee)) {
        assignment.set(trustee, baseGroup);
      }
    }
  }
  return assignment;
}

function buildBaseGroupEnableTargets(
  avatarBaseGroupAssignments: Map<string, string>,
  allowedAvatars: Set<string>,
  blacklistedAvatars: Set<string>,
  isEligible: (avatar: string) => boolean
): {targets: EnableTarget[]; scheduledAvatars: Set<string>} {
  const grouped = new Map<string, string[]>();
  const scheduledAvatars = new Set<string>();

  for (const [avatar, baseGroup] of avatarBaseGroupAssignments.entries()) {
    if (!allowedAvatars.has(avatar) || blacklistedAvatars.has(avatar)) {
      continue;
    }

    if (!isEligible(avatar)) {
      continue;
    }

    if (!grouped.has(baseGroup)) {
      grouped.set(baseGroup, []);
    }
    grouped.get(baseGroup)?.push(avatar);
    scheduledAvatars.add(avatar);
  }

  const targets: EnableTarget[] = [];
  for (const [baseGroup, avatars] of grouped.entries()) {
    if (avatars.length > 0) {
      targets.push({baseGroup, addresses: avatars, source: "base-group"});
    }
  }

  return {targets, scheduledAvatars};
}
