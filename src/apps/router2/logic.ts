import {getAddress} from "ethers";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IRouter2Service} from "../../interfaces/IRouter2Service";

export const DEFAULT_ROUTER2_ADDRESS = "0xA60Cd6ddbB4eBa93246D6f80ff4504476c8117D1";
export const DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS = "0x93eD5A96347927ff6fF6b790F8Cf5258240c321f";
export const DEFAULT_ROUTER2_ADMIN_SAFE_ADDRESS = "0xcC05dab6e530b5E846DDfdEd09874BF4ADDEE8eC";
export const DEFAULT_ROUTER2_BATCH_SIZE = 20;
export const DEFAULT_ROUTER2_FETCH_PAGE_SIZE = 2_000;

export type RunConfig = {
  routerAddress: string;
  trustedByAddress: string;
  dryRun?: boolean;
  batchSize?: number;
  fetchPageSize?: number;
  logBatchAddresses?: boolean;
  approvalsFromBlock?: number;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  logger: ILoggerService;
  router2Service?: IRouter2Service;
};

export type Router2RunOutcome = {
  totalTrustedRows: number;
  uniqueTrustedCount: number;
  routingCandidateCount: number;
  routingTxHashes: string[];
  totalHumanRows: number;
  uniqueHumanCount: number;
  approvalCandidateCount: number;
  approvalTxHashes: string[];
  dryRun: boolean;
};

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<Router2RunOutcome> {
  const fetchPageSize = Math.max(1, cfg.fetchPageSize ?? DEFAULT_ROUTER2_FETCH_PAGE_SIZE);
  const routerAddress = normalizeAddress(cfg.routerAddress);
  if (!routerAddress) {
    throw new Error(`Invalid router2 address configured: '${cfg.routerAddress}'`);
  }

  const trustedByAddress = normalizeAddress(cfg.trustedByAddress);
  if (!trustedByAddress) {
    throw new Error(`Invalid router2 trusted-by address configured: '${cfg.trustedByAddress}'`);
  }

  deps.logger.info(`Fetching trustees trusted by ${trustedByAddress}...`);
  const trustedRows = await deps.circlesRpc.fetchAllTrustees(trustedByAddress);
  deps.logger.info(`Fetched ${trustedRows.length} trustee row(s).`);

  deps.logger.info(`Fetching addresses already trusted by router2 ${routerAddress}...`);
  const routerTrustedRows = await deps.circlesRpc.fetchAllTrustees(routerAddress);
  deps.logger.info(`Router2 already trusts ${routerTrustedRows.length} trustee row(s).`);

  deps.logger.info(formatApprovalFetchMessage(cfg.approvalsFromBlock));
  const humanRows = await fetchApprovalHumanRows(deps, fetchPageSize, cfg.approvalsFromBlock);
  deps.logger.info(`Fetched ${humanRows.length} RegisterHuman row(s).`);

  return executeRouter2Plan(deps, cfg, trustedRows, routerTrustedRows, humanRows);
}

export async function runApprovalsForHumanAvatars(
  deps: Deps,
  cfg: RunConfig,
  humanAvatarRows: string[]
): Promise<Router2RunOutcome> {
  return executeRouter2Plan(deps, cfg, [], [], humanAvatarRows);
}

async function executeRouter2Plan(
  deps: Deps,
  cfg: RunConfig,
  trustedRows: string[],
  routerTrustedRows: string[],
  humanRows: string[]
): Promise<Router2RunOutcome> {
  const {logger, router2Service} = deps;
  const dryRun = !!cfg.dryRun;

  const routerAddress = normalizeAddress(cfg.routerAddress);
  if (!routerAddress) {
    throw new Error(`Invalid router2 address configured: '${cfg.routerAddress}'`);
  }

  const trustedByAddress = normalizeAddress(cfg.trustedByAddress);
  if (!trustedByAddress) {
    throw new Error(`Invalid router2 trusted-by address configured: '${cfg.trustedByAddress}'`);
  }

  if (!dryRun && !router2Service) {
    throw new Error("Router2 service dependency is required when router2 is not running in dry-run mode.");
  }

  const batchSize = Math.max(1, cfg.batchSize ?? DEFAULT_ROUTER2_BATCH_SIZE);
  const desiredRoutingCandidates = uniqueNormalizedAddresses(trustedRows, logger);
  const routerTrustedSet = new Set(uniqueNormalizedAddresses(routerTrustedRows, logger));
  const routingCandidates = desiredRoutingCandidates.filter((address) => !routerTrustedSet.has(address));
  const approvalCandidates = uniqueNormalizedAddresses(humanRows, logger);

  logger.info(
    `router2 plan: routing=${routingCandidates.length}/${desiredRoutingCandidates.length} missing trusted address(es), ` +
    `approval=${approvalCandidates.length} human avatar(s), batchSize=${batchSize}, dryRun=${dryRun}.`
  );

  const routingTxHashes = await executeBatches({
    label: "enableCRCForRouting",
    addresses: routingCandidates,
    batchSize,
    dryRun,
    logBatchAddresses: !!cfg.logBatchAddresses,
    logger,
    execute: (batch) => router2Service!.enableCRCForRouting(batch),
    simulate: router2Service?.simulateEnableCRCForRouting
      ? (batch) => router2Service.simulateEnableCRCForRouting!(batch)
      : undefined
  });

  const approvalTxHashes = await executeBatches({
    label: "setApprovalForCRC",
    addresses: approvalCandidates,
    batchSize,
    dryRun,
    logBatchAddresses: !!cfg.logBatchAddresses,
    logger,
    execute: (batch) => router2Service!.setApprovalForCRC(batch),
    simulate: router2Service?.simulateSetApprovalForCRC
      ? (batch) => router2Service.simulateSetApprovalForCRC!(batch)
      : undefined
  });

  return {
    totalTrustedRows: trustedRows.length,
    uniqueTrustedCount: desiredRoutingCandidates.length,
    routingCandidateCount: routingCandidates.length,
    routingTxHashes,
    totalHumanRows: humanRows.length,
    uniqueHumanCount: approvalCandidates.length,
    approvalCandidateCount: approvalCandidates.length,
    approvalTxHashes,
    dryRun
  };
}

type ExecuteBatchesArgs = {
  label: string;
  addresses: string[];
  batchSize: number;
  dryRun: boolean;
  logBatchAddresses: boolean;
  logger: ILoggerService;
  execute: (batch: string[]) => Promise<string>;
  simulate?: (batch: string[]) => Promise<{gasEstimate: bigint}>;
};

async function executeBatches(args: ExecuteBatchesArgs): Promise<string[]> {
  const {label, addresses, batchSize, dryRun, logBatchAddresses, logger, execute, simulate} = args;
  const batches = chunkArray(addresses, batchSize);
  const txHashes: string[] = [];

  if (addresses.length === 0) {
    logger.info(`router2 ${label}: no addresses to process.`);
    return txHashes;
  }

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchLabel = `${index + 1}/${batches.length}`;

    if (dryRun) {
      logger.info(
        `[DRY-RUN] router2 ${label} batch ${batchLabel}: ` +
        formatBatchAddresses(batch, logBatchAddresses)
      );
      if (simulate) {
        const simulation = await simulate(batch);
        logger.info(
          `[DRY-RUN] router2 ${label} simulation ${batchLabel}: ` +
          `ok, gasEstimate=${simulation.gasEstimate.toString()}.`
        );
      } else {
        logger.info(`[DRY-RUN] router2 ${label} simulation ${batchLabel}: skipped (no signer-backed simulator configured).`);
      }
      continue;
    }

    logger.info(`router2 ${label} batch ${batchLabel}: processing ${batch.length} address(es).`);
    const txHash = await execute(batch);
    txHashes.push(txHash);
    logger.info(`router2 ${label} tx=${txHash} batch ${batchLabel}.`);
  }

  return txHashes;
}

function formatBatchAddresses(batch: string[], includeAddresses: boolean): string {
  if (includeAddresses) {
    return `${batch.length} address(es) -> ${batch.join(", ")}.`;
  }

  const first = batch[0];
  const last = batch[batch.length - 1];
  if (!first || !last) {
    return "0 address(es).";
  }

  return `${batch.length} address(es) (${first} ... ${last}).`;
}

function uniqueNormalizedAddresses(addresses: string[], logger: ILoggerService): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
      skipped += 1;
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  if (skipped > 0) {
    logger.warn(`Skipped ${skipped} invalid router2 address(es).`);
  }

  return result;
}

function normalizeAddress(address: string | undefined | null): string | undefined {
  if (!address) {
    return undefined;
  }

  try {
    return getAddress(address).toLowerCase();
  } catch {
    return undefined;
  }
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

async function fetchApprovalHumanRows(
  deps: Deps,
  fetchPageSize: number,
  approvalsFromBlock: number | undefined
): Promise<string[]> {
  const humansLogger = deps.logger.child("humans");
  if (approvalsFromBlock === undefined) {
    return deps.circlesRpc.fetchAllHumanAvatars(fetchPageSize, humansLogger);
  }

  if (!Number.isInteger(approvalsFromBlock) || approvalsFromBlock < 0) {
    throw new Error(`Invalid router2 approvals-from block configured: '${approvalsFromBlock}'`);
  }

  if (!deps.circlesRpc.fetchHumanAvatarsRegisteredAfterBlock) {
    throw new Error("Circles RPC dependency does not support block-filtered RegisterHuman fetching.");
  }

  return deps.circlesRpc.fetchHumanAvatarsRegisteredAfterBlock(approvalsFromBlock, fetchPageSize, humansLogger);
}

function formatApprovalFetchMessage(approvalsFromBlock: number | undefined): string {
  if (approvalsFromBlock === undefined) {
    return "Fetching Circles v2 human avatars for router2 approval...";
  }

  return `Fetching Circles v2 human avatars registered after block ${approvalsFromBlock} for router2 approval...`;
}

export const __testables = {
  chunkArray,
  formatApprovalFetchMessage,
  formatBatchAddresses,
  normalizeAddress,
  uniqueNormalizedAddresses
};
