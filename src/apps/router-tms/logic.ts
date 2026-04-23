import {getAddress} from "ethers";
import {IBlacklistingService, IBlacklistServiceVerdict} from "../../interfaces/IBlacklistingService";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IRouterService} from "../../interfaces/IRouterService";
import {
  IRouterEnablementStore,
  RouterEnablementSource,
  RouterEnablementStatus
} from "../../interfaces/IRouterEnablementStore";
import {isTransientRpcError} from "../../services/retryWithBackoff";

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

export type FailureType = "safe-level" | "address-specific" | "unknown";

export type FailedBatch = {
  baseGroup: string;
  batchIndex: number;
  batchSize: number;
  addresses: string[];
  error: string;
  failureType: FailureType;
};

export type RunOutcome = {
  totalAvatarEntries: number;
  uniqueHumanCount: number;
  allowedHumanCount: number;
  blacklistedHumanCount: number;
  alreadyTrustedCount: number;
  pendingEnableCount: number;
  executedEnableCount: number;
  failedBatches: FailedBatch[];
  quarantinedAddresses: string[];
  dryRun: boolean;
  txHashes: string[];
};

type EnableTarget = {baseGroup: string; addresses: string[]; source?: "base-group" | "fallback"};
type HumanityChecker = {
  isHuman: (address: string) => Promise<boolean>;
  isHumanBatch: (addresses: string[]) => Promise<Map<string, boolean>>;
};
type BulkTrusteesStats = {
  pagesFetched: number;
  rowsScanned: number;
};
type BulkTrusteesStatsProvider = {
  getLastBulkTrusteesForTrustersStats: () => BulkTrusteesStats;
};

/** Safe-level error codes that are NOT address-specific — they affect ALL transactions
 *  regardless of the addresses in the batch payload.
 *  - GS013: execTransaction failure when gasPrice=0 and safeTxGas=0
 *  - GS020-GS026: checkNSignatures signature validation failures
 *  These should NOT trigger per-address probing or quarantine since every address
 *  would fail identically. */
const SAFE_LEVEL_ERROR_CODES = ["GS013", "GS020", "GS021", "GS022", "GS023", "GS024", "GS025", "GS026"];
const SAFE_LEVEL_PATTERN = new RegExp(SAFE_LEVEL_ERROR_CODES.join("|"));

function isSafeLevelError(err: unknown): boolean {
  if (err == null) return false;
  const msg = String((err as any)?.message ?? "");
  const reason = String((err as any)?.reason ?? "");
  return SAFE_LEVEL_PATTERN.test(msg) || SAFE_LEVEL_PATTERN.test(reason);
}

export const DEFAULT_ENABLE_BATCH_SIZE = 10;
export const DEFAULT_FETCH_PAGE_SIZE = 1_000;
export const DEFAULT_BASE_GROUP_ADDRESS = "0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026";
const BASE_GROUP_TRUST_QUERY_BATCH_SIZE = 100;
const HUMANITY_CHECK_BATCH_SIZE = 50;

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<RunOutcome> {
  const {circlesRpc, logger} = deps;
  const fetchPageSize = Math.max(1, cfg.fetchPageSize ?? DEFAULT_FETCH_PAGE_SIZE);

  logger.info("Fetching human avatars from RegisterHuman table...");
  const allHumanAvatars = await circlesRpc.fetchAllHumanAvatars(fetchPageSize, logger);
  logger.info(`Fetched ${allHumanAvatars.length} avatar row(s) from RegisterHuman.`);

  return runForHumanAvatars(deps, cfg, allHumanAvatars);
}

export async function runForHumanAvatars(
  deps: Deps,
  cfg: RunConfig,
  humanAvatarEntries: string[]
): Promise<RunOutcome> {
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
  const humanityChecker = createHumanityChecker(circlesRpc);
  const {isHuman, isHumanBatch} = humanityChecker;

  await assertBaseGroupIsGroupAvatar(baseGroupAddress, isHuman, logger);

  const totalAvatarEntries = humanAvatarEntries.length;
  const uniqueHumanAvatars = Array.from(new Set(humanAvatarEntries));
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
  const enablementStatuses = createEnablementStatusMap(await enablementStore.loadEnablementStatuses());

  const allowedHumanSet = new Set(allowedHumanAvatars);
  const blacklistedSet = new Set(blacklistedHumanAvatars);
  const avatarBaseGroupAssignments = await buildAvatarBaseGroupAssignments(circlesRpc, logger);

  const baseGroupEligibilityFilter = (avatar: string): boolean =>
    shouldEnableAvatarForSource(avatar, "base-group", routerTrustSet, enablementStatuses);

  const {
    targets: baseGroupEnableTargets,
    scheduledAvatars: baseGroupScheduledAvatars
  } = buildBaseGroupEnableTargets(
    avatarBaseGroupAssignments,
    allowedHumanSet,
    blacklistedSet,
    baseGroupEligibilityFilter
  );

  const remainingHumanAvatars = allowedHumanAvatars.filter(
    (avatar) =>
      shouldEnableAvatarForSource(avatar, "fallback", routerTrustSet, enablementStatuses) &&
      !baseGroupScheduledAvatars.has(avatar)
  );

  const enableTargets: EnableTarget[] = [...baseGroupEnableTargets];
  if (remainingHumanAvatars.length > 0) {
    enableTargets.push({baseGroup: baseGroupAddress, addresses: remainingHumanAvatars, source: "fallback"});
  }

  const {validTargets, nonHumanAvatars} = await validateEnableTargets(
    enableTargets,
    isHuman,
    isHumanBatch,
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
      failedBatches: [],
      quarantinedAddresses: [],
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
  const failedBatches: FailedBatch[] = [];
  // Quarantine is global across base groups. This is safe because each avatar is assigned
  // to exactly one base group (via buildAvatarBaseGroupAssignments) and cannot appear in
  // multiple targets. Persisted quarantine with TTL avoids re-probing permanently bad
  // addresses every run cycle.
  const persistedQuarantined = new Set(
    (await enablementStore.loadQuarantinedAddresses()).map(a => a.toLowerCase())
  );
  const quarantined = new Set<string>(persistedQuarantined);
  if (persistedQuarantined.size > 0) {
    logger.info(`Loaded ${persistedQuarantined.size} previously quarantined address(es).`);
  }

  for (const target of validTargets) {
    const batches = chunkArray(target.addresses, enableBatchSize);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const rawBatch = batches[batchIndex];
      const batch = rawBatch.filter((addr) => !quarantined.has(addr.toLowerCase()));
      if (batch.length === 0) {
        logger.info(
          `Skipping batch ${batchIndex + 1}/${batches.length} for base group ${target.baseGroup} — all addresses quarantined.`
        );
        continue;
      }

      const batchLabel = `batch ${batchIndex + 1}/${batches.length}`;
      if (dryRun || !routerService) {
        logger.info(
          `[DRY-RUN] Would call enableCRCForRouting with ${batch.length} avatar(s) ` +
            `(${batchLabel}) for base group ${target.baseGroup}: ${batch.join(", ")}.`
        );
        if (routerService?.simulateEnableCRCForRouting) {
          try {
            const simulation = await routerService.simulateEnableCRCForRouting(target.baseGroup, batch);
            logger.info(
              `[DRY-RUN] enableCRCForRouting simulation ${batchLabel}: ok, gasEstimate=${simulation.gasEstimate.toString()}.`
            );
          } catch (simError) {
            const errMsg = simError instanceof Error ? simError.message : String(simError);
            logger.warn(
              `[DRY-RUN] enableCRCForRouting simulation ${batchLabel} FAILED ` +
              `for ${batch.length} avatar(s) in base group ${target.baseGroup}: ${errMsg}`
            );
            failedBatches.push({
              baseGroup: target.baseGroup,
              batchIndex: batchIndex + 1,
              batchSize: batch.length,
              addresses: batch,
              error: errMsg,
              failureType: "unknown"
            });
          }
        } else {
          logger.info(
            `[DRY-RUN] enableCRCForRouting simulation ${batchLabel}: skipped (no signer-backed simulator configured).`
          );
        }
        continue;
      }

      const result = await executeBatchWithFallback(
        routerService, enablementStore, logger,
        target.baseGroup, batch, batchLabel, batchIndex + 1, routerTrustSet,
        target.source ?? "fallback"
      );
      txHashes.push(...result.txHashes);
      executedEnableCount += result.enabledCount;
      for (const addr of result.quarantinedInThisBatch) {
        quarantined.add(addr.toLowerCase());
      }
      if (result.failedBatchEntry) {
        failedBatches.push(result.failedBatchEntry);
      }
    }
  }

  // Persist newly quarantined addresses (don't reset TTL on previously known ones)
  const newlyQuarantined = Array.from(quarantined).filter(a => !persistedQuarantined.has(a));
  if (newlyQuarantined.length > 0) {
    await enablementStore.markQuarantined(newlyQuarantined);
  }

  return {
    totalAvatarEntries,
    uniqueHumanCount: uniqueHumanAvatars.length,
    allowedHumanCount: allowedHumanAvatars.length,
    blacklistedHumanCount: blacklistedHumanAvatars.length,
    alreadyTrustedCount: alreadyTrusted.length,
    pendingEnableCount,
    executedEnableCount: dryRun ? 0 : executedEnableCount,
    failedBatches,
    quarantinedAddresses: newlyQuarantined,
    dryRun,
    txHashes
  };
}

type BatchFallbackResult = {
  txHashes: string[];
  enabledCount: number;
  quarantinedInThisBatch: string[];
  failedBatchEntry?: FailedBatch;
};

async function executeBatchWithFallback(
  routerService: IRouterService,
  enablementStore: IRouterEnablementStore,
  logger: ILoggerService,
  baseGroup: string,
  batch: string[],
  batchLabel: string,
  batchIndex: number,
  routerTrustSet: Set<string>,
  source: RouterEnablementSource
): Promise<BatchFallbackResult> {
  const newlyQuarantined: string[] = [];

  // Phase 1: try the full batch
  try {
    const txHash = await routerService.enableCRCForRouting(baseGroup, batch);
    await enablementStore.markEnabled(batch, source);
    batch.forEach((address) => routerTrustSet.add(address));
    logger.info(
      `enableCRCForRouting tx=${txHash} (${batchLabel}) for ${batch.length} avatar(s) in base group ${baseGroup}.`
    );
    return {txHashes: [txHash], enabledCount: batch.length, quarantinedInThisBatch: []};
  } catch (batchError) {
    const errMsg = batchError instanceof Error ? batchError.message : String(batchError);
    logger.warn(
      `enableCRCForRouting FAILED (${batchLabel}) for ${batch.length} avatar(s) in base group ${baseGroup}: ${errMsg}`
    );

    // Safe-level errors (e.g. GS026 "Invalid owner") are NOT address-specific.
    // Probing individual addresses would produce the same error and wrongly
    // quarantine them all. Fail fast with a clear message instead.
    if (isSafeLevelError(batchError)) {
      logger.error(
        `Safe-level error in ${batchLabel}: ${errMsg}. ` +
        `This is NOT address-specific — skipping per-address probing. ` +
        `Check Safe signer configuration (GS026 = signature validation failed, typically signer not an owner or chainId/nonce mismatch).`
      );
      return {
        txHashes: [],
        enabledCount: 0,
        quarantinedInThisBatch: [],
        failedBatchEntry: {baseGroup, batchIndex, batchSize: batch.length, addresses: batch, error: errMsg, failureType: "safe-level"}
      };
    }

    // No simulation available — record as failed batch (existing behavior)
    if (!routerService.simulateEnableCRCForRouting) {
      logger.error(`Failed batch addresses: ${batch.join(", ")}`);
      return {
        txHashes: [],
        enabledCount: 0,
        quarantinedInThisBatch: [],
        failedBatchEntry: {baseGroup, batchIndex, batchSize: batch.length, addresses: batch, error: errMsg, failureType: "unknown"}
      };
    }

    // Single-address batch — no need to probe, just quarantine it
    if (batch.length === 1) {
      newlyQuarantined.push(batch[0]);
      logger.warn(`Quarantined address ${batch[0]} — failed in base group ${baseGroup}: ${errMsg}`);
      return {
        txHashes: [],
        enabledCount: 0,
        quarantinedInThisBatch: newlyQuarantined,
        failedBatchEntry: {baseGroup, batchIndex, batchSize: 1, addresses: batch, error: errMsg, failureType: "address-specific"}
      };
    }

    // Phase 2: probe each address individually via simulation
    logger.info(`Probing ${batch.length} address(es) individually to identify revert-causing address(es)...`);
    const good: string[] = [];
    const bad: string[] = [];

    for (const addr of batch) {
      try {
        await routerService.simulateEnableCRCForRouting(baseGroup, [addr]);
        good.push(addr);
      } catch (probeErr) {
        // Transient RPC errors (timeouts, rate limits) are not proof the address is bad —
        // keep it in the retry batch rather than quarantining it.
        if (isTransientRpcError(probeErr)) {
          good.push(addr);
          const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          logger.warn(`Probe for ${addr} hit transient RPC error — keeping in retry batch: ${probeMsg}`);
        } else {
          bad.push(addr);
          newlyQuarantined.push(addr);
          const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          logger.warn(`Quarantined address ${addr} — simulation revert: ${probeMsg}`);
        }
      }
    }

    if (bad.length > 0) {
      logger.warn(`Identified ${bad.length} revert-causing address(es): ${bad.join(", ")}`);
    }

    if (good.length === 0) {
      logger.error(`All ${batch.length} address(es) in ${batchLabel} cause reverts. No retry possible.`);
      return {
        txHashes: [],
        enabledCount: 0,
        quarantinedInThisBatch: newlyQuarantined,
        failedBatchEntry: {baseGroup, batchIndex, batchSize: batch.length, addresses: batch, error: errMsg, failureType: "address-specific"}
      };
    }

    // Phase 3: retry with only the valid addresses
    logger.info(`Retrying ${batchLabel} with ${good.length} valid address(es) (${bad.length} quarantined).`);
    try {
      const txHash = await routerService.enableCRCForRouting(baseGroup, good);
      await enablementStore.markEnabled(good, source);
      good.forEach((address) => routerTrustSet.add(address));
      logger.info(
        `enableCRCForRouting retry tx=${txHash} (${batchLabel}) for ${good.length} avatar(s) in base group ${baseGroup}.`
      );
      return {txHashes: [txHash], enabledCount: good.length, quarantinedInThisBatch: newlyQuarantined};
    } catch (retryError) {
      const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
      logger.error(`enableCRCForRouting retry FAILED (${batchLabel}): ${retryMsg}`);
      return {
        txHashes: [],
        enabledCount: 0,
        quarantinedInThisBatch: newlyQuarantined,
        failedBatchEntry: {baseGroup, batchIndex, batchSize: good.length, addresses: good, error: retryMsg, failureType: "unknown"}
      };
    }
  }
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

function createEnablementStatusMap(statuses: RouterEnablementStatus[]): Map<string, RouterEnablementStatus> {
  const map = new Map<string, RouterEnablementStatus>();
  for (const status of statuses) {
    const normalized = normalizeAddress(status.avatar);
    if (!normalized) {
      continue;
    }

    map.set(normalized, {
      avatar: normalized,
      fallbackEnabled: status.fallbackEnabled === true,
      baseGroupEnabled: status.baseGroupEnabled === true
    });
  }
  return map;
}

function shouldEnableAvatarForSource(
  avatar: string,
  source: RouterEnablementSource,
  routerTrustSet: Set<string>,
  enablementStatuses: Map<string, RouterEnablementStatus>
): boolean {
  const status = enablementStatuses.get(avatar);

  if (source === "fallback") {
    if (status?.fallbackEnabled || status?.baseGroupEnabled) {
      return false;
    }
    return !routerTrustSet.has(avatar);
  }

  if (status?.baseGroupEnabled) {
    return false;
  }

  if (status?.fallbackEnabled) {
    return true;
  }

  return !routerTrustSet.has(avatar);
}

function getBulkTrusteesStats(circlesRpc: ICirclesRpc): BulkTrusteesStats | undefined {
  if (
    "getLastBulkTrusteesForTrustersStats" in circlesRpc &&
    typeof circlesRpc.getLastBulkTrusteesForTrustersStats === "function"
  ) {
    return (circlesRpc as ICirclesRpc & BulkTrusteesStatsProvider).getLastBulkTrusteesForTrustersStats();
  }
  return undefined;
}

function createHumanityChecker(circlesRpc: ICirclesRpc): HumanityChecker {
  const cache = new Map<string, Promise<boolean>>();

  const isHuman = async (address: string): Promise<boolean> => {
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

  const isHumanBatch = async (addresses: string[]): Promise<Map<string, boolean>> => {
    const normalizedAddresses = addresses.map((address) => {
      const normalized = normalizeAddress(address);
      if (!normalized) {
        throw new Error(`Invalid address passed to isHuman check: '${address ?? ""}'`);
      }
      return normalized;
    });

    const missingAddresses = Array.from(
      new Set(normalizedAddresses.filter((address) => !cache.has(address)))
    );

    if (missingAddresses.length > 0) {
      const lookup = circlesRpc.isHumanBatch(missingAddresses);
      for (const address of missingAddresses) {
        const verdict = lookup.then((results) => results.get(address) === true).catch((error) => {
          cache.delete(address);
          throw error;
        });
        cache.set(address, verdict);
      }
    }

    const result = new Map<string, boolean>();
    for (const address of normalizedAddresses) {
      result.set(address, await isHuman(address));
    }
    return result;
  };

  return {isHuman, isHumanBatch};
}

function createIsHumanChecker(circlesRpc: ICirclesRpc): (address: string) => Promise<boolean> {
  return createHumanityChecker(circlesRpc).isHuman;
}

function createIsHumanBatchChecker(circlesRpc: ICirclesRpc): (addresses: string[]) => Promise<Map<string, boolean>> {
  return createHumanityChecker(circlesRpc).isHumanBatch;
}

async function filterHumanAvatars(
  addresses: string[],
  isHumanBatch: (addresses: string[]) => Promise<Map<string, boolean>>,
  batchSize: number
): Promise<{humans: string[]; nonHumans: string[]}> {
  const humans: string[] = [];
  const nonHumans: string[] = [];

  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const verdicts = await isHumanBatch(batch);

    for (const address of batch) {
      if (verdicts.get(address.toLowerCase()) === true) {
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
  isHumanBatch: (addresses: string[]) => Promise<Map<string, boolean>>,
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

    const {humans, nonHumans} = await filterHumanAvatars(target.addresses, isHumanBatch, HUMANITY_CHECK_BATCH_SIZE);
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

  const baseGroupBatches = chunkArray(normalizedBaseGroups, BASE_GROUP_TRUST_QUERY_BATCH_SIZE);
  logger.info(
    `Fetching trustees for ${normalizedBaseGroups.length} base group(s) across ${baseGroupBatches.length} trust-query batch(es).`
  );

  const trusteesByBaseGroup = new Map<string, string[]>();
  let totalPagesFetched = 0;
  let totalRowsScanned = 0;

  for (const batch of baseGroupBatches) {
    const trusteesByTruster = await circlesRpc.fetchAllTrusteesForTrusters(batch);
    const stats = getBulkTrusteesStats(circlesRpc);
    totalPagesFetched += stats?.pagesFetched ?? 0;

    if (stats) {
      totalRowsScanned += stats.rowsScanned;
    } else {
      totalRowsScanned += Array.from(trusteesByTruster.values()).reduce((sum, trustees) => sum + trustees.length, 0);
    }

    for (const baseGroup of batch) {
      trusteesByBaseGroup.set(baseGroup, trusteesByTruster.get(baseGroup) ?? []);
    }
  }

  logger.info(
    `Fetched trustee rows for base groups across ${baseGroupBatches.length} trust-query batch(es), ` +
      `${totalPagesFetched} page(s), and ${totalRowsScanned} trustee row(s).`
  );

  const assignment = new Map<string, string>();
  for (const baseGroup of normalizedBaseGroups) {
    const trustees = trusteesByBaseGroup.get(baseGroup) ?? [];
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

export const __testables = {
  buildAvatarBaseGroupAssignments,
  buildBaseGroupEnableTargets,
  chunkArray,
  createHumanityChecker,
  createIsHumanChecker,
  createIsHumanBatchChecker,
  filterHumanAvatars,
  isBlacklisted,
  isSafeLevelError,
  normalizeAddress,
  normalizeAddressArray,
  validateEnableTargets
};
